import { Types, type ClientSession, type Connection } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPendingRegistration } from '../src/modules/identity/models/pending-registration.model.js';
import type { VerifiedRegistrationProof } from '../src/modules/auth/registration/registration.service.js';
import { RegistrationActivationService } from '../src/modules/auth/registration/activation.service.js';

const stores = vi.hoisted(() => ({
  createUser: vi.fn(),
  createIdentity: vi.fn(),
  createAudit: vi.fn(),
  redeem: vi.fn(),
  redeemExec: vi.fn(),
}));

vi.mock('../src/modules/identity/models/index.js', () => ({
  getUserModel: () => ({ create: stores.createUser }),
  getAuthIdentityModel: () => ({ create: stores.createIdentity }),
  getRegistrationAllowlistModel: () => ({ findOneAndUpdate: stores.redeem }),
  getSecurityAuditEventModel: () => ({ create: stores.createAudit }),
}));

const requestId = '00000000-0000-4000-8000-000000000003';

function fixture(mode: 'PUBLIC' | 'INVITE_ONLY' = 'PUBLIC') {
  let active = false;
  const driverSession = {
    startTransaction: vi.fn(() => { active = true; }),
    inTransaction: vi.fn(() => active),
    commitTransaction: vi.fn(async () => { active = false; }),
    abortTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => undefined),
  };
  const session = driverSession as unknown as ClientSession;
  const connection = {
    readyState: 1,
    startSession: vi.fn(async () => session),
  } as unknown as Connection;

  const pending: IPendingRegistration = {
    registrationId: 'synthetic-registration',
    emailNormalized: 'synthetic@example.test',
    passwordHash: 'synthetic-hash-not-a-real-credential',
    nonceDigest: 'synthetic-nonce-digest',
    otpDigest: 'synthetic-otp-digest',
    version: 1,
    attempts: 1,
    resendCount: 0,
    state: 'CONSUMED',
    deliveryState: 'ACCEPTED',
    otpExpiresAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 60_000),
    consentVersion: 'v1',
    displayName: 'Synthetic Candidate',
  };
  const proof: VerifiedRegistrationProof = {
    registrationId: pending.registrationId,
    version: pending.version,
    emailNormalized: pending.emailNormalized,
    nonceDigest: pending.nonceDigest,
    expiresAt: pending.expiresAt,
  };
  const consumePendingRegistration = vi.fn(async (
    _proof: VerifiedRegistrationProof,
    _session: ClientSession
  ) => pending);
  const service = new RegistrationActivationService({
    connection,
    pendingRegistrationService: { consumePendingRegistration },
    policy: {
      POLICY_ID: 'test-policy',
      POLICY_CONSENT_VERSION: 'v1',
      REGISTRATION_MODE: mode,
    },
  });
  return { driverSession, session, pending, proof, consumePendingRegistration, service };
}

describe('P2-AUTH-03b registration activation transaction orchestration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stores.redeem.mockReturnValue({ exec: stores.redeemExec });
    stores.redeemExec.mockResolvedValue({ emailNormalized: 'synthetic@example.test' });
    stores.createUser.mockResolvedValue([]);
    stores.createIdentity.mockResolvedValue([]);
    stores.createAudit.mockResolvedValue([]);
  });

  it('creates only the verified principal, exact pending password factor and consent event in one transaction', async () => {
    const f = fixture();
    await f.service.activate(f.proof, requestId);

    expect(f.consumePendingRegistration).toHaveBeenCalledWith(f.proof, f.session);
    const user = stores.createUser.mock.calls[0]?.[0]?.[0];
    expect(user).toMatchObject({
      emailNormalized: f.pending.emailNormalized,
      role: 'CANDIDATE', accountStatus: 'ACTIVE', sessionEpoch: 1, identityVersion: 1,
      consentVersion: 'v1', displayName: 'Synthetic Candidate',
    });
    expect(user._id).toBeInstanceOf(Types.ObjectId);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(stores.createIdentity).toHaveBeenCalledWith([expect.objectContaining({
      userId: user._id, provider: 'PASSWORD', subject: f.pending.emailNormalized,
      passwordHash: f.pending.passwordHash,
    })], { session: f.session });
    expect(stores.createAudit).toHaveBeenCalledWith([expect.objectContaining({
      eventId: expect.any(String), eventType: 'CONSENT_ACCEPTED', requestId,
      actorId: String(user._id), targetId: String(user._id),
      metadata: {
        userId: String(user._id), policyId: 'test-policy', consentVersion: 'v1',
        consentAt: user.consentAt,
      },
    })], { session: f.session });
    expect(stores.createUser).toHaveBeenCalledWith([user], { session: f.session });
    expect(stores.redeem).not.toHaveBeenCalled();
    expect(f.driverSession.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('consumes an eligible invite atomically using the new principal ID', async () => {
    const f = fixture('INVITE_ONLY');
    await f.service.activate(f.proof, requestId);
    const user = stores.createUser.mock.calls[0]?.[0]?.[0];
    expect(stores.redeem).toHaveBeenCalledWith({
      emailNormalized: f.pending.emailNormalized,
      redeemedBy: { $exists: false }, redeemedAt: { $exists: false },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: expect.any(Date) } }],
    }, {
      $set: { redeemedBy: user._id, redeemedAt: user.consentAt },
    }, { new: true, session: f.session });
    expect(f.driverSession.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('aborts on a stale consent version without creating a principal', async () => {
    const f = fixture();
    f.pending.consentVersion = 'obsolete';
    await expect(f.service.activate(f.proof, requestId)).rejects.toMatchObject({
      statusCode: 400, code: 'OTP_INVALID',
    });
    expect(stores.createUser).not.toHaveBeenCalled();
    expect(stores.createIdentity).not.toHaveBeenCalled();
    expect(stores.createAudit).not.toHaveBeenCalled();
    expect(f.driverSession.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driverSession.commitTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the invite has expired, been redeemed or is absent', async () => {
    const f = fixture('INVITE_ONLY');
    stores.redeemExec.mockResolvedValue(null);
    await expect(f.service.activate(f.proof, requestId)).rejects.toMatchObject({
      statusCode: 409, code: 'STATE_CONFLICT',
    });
    expect(stores.createUser).not.toHaveBeenCalled();
    expect(stores.createIdentity).not.toHaveBeenCalled();
    expect(f.driverSession.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driverSession.commitTransaction).not.toHaveBeenCalled();
  });

  it('does not attach a password identity to an existing email on a unique-index collision', async () => {
    const f = fixture();
    stores.createUser.mockRejectedValueOnce(Object.assign(new Error('synthetic collision'), {
      code: 11000,
    }));
    await expect(f.service.activate(f.proof, requestId)).rejects.toMatchObject({
      statusCode: 409, code: 'STATE_CONFLICT',
    });
    expect(stores.createIdentity).not.toHaveBeenCalled();
    expect(stores.createAudit).not.toHaveBeenCalled();
    expect(f.driverSession.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driverSession.commitTransaction).not.toHaveBeenCalled();
  });

  it('aborts if consent evidence cannot be persisted', async () => {
    const f = fixture();
    stores.createAudit.mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(f.service.activate(f.proof, requestId)).rejects.toMatchObject({
      statusCode: 503, code: 'SERVICE_UNAVAILABLE',
    });
    expect(stores.createIdentity).toHaveBeenCalledTimes(1);
    expect(f.driverSession.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driverSession.commitTransaction).not.toHaveBeenCalled();
  });

  it('reuses the proof and stable IDs after a transient audit-write failure', async () => {
    const f = fixture();
    stores.createAudit.mockRejectedValueOnce(Object.assign(new Error('synthetic conflict'), {
      errorLabels: ['TransientTransactionError'],
    }));
    await f.service.activate(f.proof, requestId);
    expect(f.consumePendingRegistration).toHaveBeenCalledTimes(2);
    expect(f.consumePendingRegistration).toHaveBeenNthCalledWith(2, f.proof, f.session);
    const firstUser = stores.createUser.mock.calls[0]?.[0]?.[0];
    const secondUser = stores.createUser.mock.calls[1]?.[0]?.[0];
    expect(String(firstUser._id)).toBe(String(secondUser._id));
    expect(stores.createAudit.mock.calls[0]?.[0]?.[0].eventId)
      .toBe(stores.createAudit.mock.calls[1]?.[0]?.[0].eventId);
    expect(f.driverSession.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driverSession.commitTransaction).toHaveBeenCalledTimes(1);
  });
});

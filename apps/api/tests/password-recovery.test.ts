import { Types, type ClientSession, type Connection } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordRecoveryService } from '../src/modules/auth/password/recovery.service.js';
import type { PasswordService } from '../src/modules/auth/password/password.service.js';
import type { AuthRateLimitService } from '../src/modules/auth/rate-limit/rate-limit.service.js';
import type { OtpChallengeService } from '../src/modules/auth/otp/otp.service.js';
import { OtpInvalidError } from '../src/modules/auth/otp/types.js';
import type { EmailSender } from '../src/modules/auth/email/types.js';

const stores = vi.hoisted(() => ({
  findUser: vi.fn(), findIdentity: vi.fn(), findChallenge: vi.fn(),
  updateUser: vi.fn(), updateIdentity: vi.fn(), updateSessions: vi.fn(),
}));
vi.mock('../src/modules/identity/models/index.js', () => ({
  getUserModel: () => ({ findOne: stores.findUser, updateOne: stores.updateUser }),
  getAuthIdentityModel: () => ({ findOne: stores.findIdentity, updateOne: stores.updateIdentity }),
  getVerificationChallengeModel: () => ({ findOne: stores.findChallenge }),
  getSessionModel: () => ({ updateMany: stores.updateSessions }),
}));

const email = 'candidate@example.test';
const input = { email, code: '123456', newPassword: 'Synthetic-new-password-123!' };
const userId = new Types.ObjectId();
const identityId = new Types.ObjectId();
const challenge = { userId, passwordIdentityIdAtIssue: identityId,
  identityVersionAtIssue: 4, challengeId: 'synthetic-challenge', generation: 2 };
const binding = { purpose: 'RESET_PASSWORD', emailNormalized: email, userId,
  passwordIdentityIdAtIssue: identityId, identityVersionAtIssue: 4 };
const result = (value: unknown) => ({ exec: vi.fn().mockResolvedValue(value) });

function fixture() {
  stores.findUser.mockReturnValue(result({ _id: userId, emailVerifiedAt: new Date(), identityVersion: 4 }));
  stores.findIdentity.mockReturnValue(result({ _id: identityId, passwordHash: 'synthetic-hash' }));
  stores.findChallenge.mockReturnValue(result(challenge));
  stores.updateUser.mockReturnValue(result({ modifiedCount: 1 }));
  stores.updateIdentity.mockReturnValue(result({ matchedCount: 1 }));
  stores.updateSessions.mockReturnValue(result({ modifiedCount: 2 }));
  let active = false;
  const driver = {
    startTransaction: vi.fn(() => { active = true; }),
    inTransaction: vi.fn(() => active),
    commitTransaction: vi.fn(async () => { active = false; }),
    abortTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => undefined),
  };
  const session = driver as unknown as ClientSession;
  const connection = { readyState: 1, startSession: vi.fn(async () => session) } as unknown as Connection;
  const proof = { challengeId: challenge.challengeId };
  const otp = {
    issueChallenge: vi.fn(async () => ({ challengeId: challenge.challengeId, generation: 2, otpCode: '123456' })),
    markDeliveryState: vi.fn(async () => true),
    verifyAuthoritativeRecoveryBinding: vi.fn(async () => undefined),
    claimAndVerifyAttempt: vi.fn(async () => proof),
    consumeVerifiedChallenge: vi.fn(async () => undefined),
  };
  const passwords = { hashPassword: vi.fn(async () => 'synthetic-new-hash') };
  const rateLimits = { consumeOrThrow: vi.fn(async () => undefined) };
  const send = vi.fn<EmailSender['sendOtpEmail']>().mockResolvedValue({ accepted: true, provider: 'mock' });
  const emailAvailable = vi.fn(async () => true);
  const service = new PasswordRecoveryService({
    connection, otp: otp as unknown as OtpChallengeService,
    passwords: passwords as unknown as PasswordService,
    rateLimits: rateLimits as unknown as AuthRateLimitService,
    emailSender: { providerName: 'mock', sendOtpEmail: send }, emailAvailable,
    hmacSecret: 'synthetic-recovery-secret-for-tests',
  });
  return { service, driver, session, otp, passwords, rateLimits, send, emailAvailable, proof };
}

describe('P2-AUTH-03b password recovery', () => {
  beforeEach(() => vi.resetAllMocks());

  it('gates global provider unavailability before account lookup', async () => {
    const f = fixture();
    f.emailAvailable.mockResolvedValueOnce(false);
    await expect(f.service.forgot({ email }, 'ip')).rejects.toMatchObject({ statusCode: 503 });
    expect(stores.findUser).not.toHaveBeenCalled();
  });

  it.each(['missing', 'passwordless', 'unverified'])('keeps %s recovery requests generic', async kind => {
    const f = fixture();
    if (kind === 'missing') stores.findUser.mockReturnValue(result(null));
    if (kind === 'passwordless') stores.findIdentity.mockReturnValue(result(null));
    if (kind === 'unverified') stores.findUser.mockReturnValue(result({ _id: userId, emailVerifiedAt: null }));
    await expect(f.service.forgot({ email }, 'ip')).resolves.toBeUndefined();
    expect(f.rateLimits.consumeOrThrow.mock.calls).toEqual([['PASSWORD_FORGOT_IP', 'ip'], ['PASSWORD_FORGOT_EMAIL', email]]);
    expect(f.otp.issueChallenge).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([true, false])('records provider acceptance %s only on the issued generation', async accepted => {
    const f = fixture();
    if (!accepted) f.send.mockRejectedValueOnce(new Error('synthetic provider failure'));
    await expect(f.service.forgot({ email }, 'ip')).resolves.toBeUndefined();
    expect(f.otp.issueChallenge).toHaveBeenCalledWith(binding);
    expect(f.otp.markDeliveryState).toHaveBeenCalledWith(challenge.challengeId, 2, accepted ? 'ACCEPTED' : 'FAILED');
  });

  it('rejects a missing challenge without hashing or changing credentials', async () => {
    const f = fixture();
    stores.findChallenge.mockReturnValue(result(null));
    await expect(f.service.reset(input, 'ip')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.otp.claimAndVerifyAttempt).not.toHaveBeenCalled();
    expect(f.passwords.hashPassword).not.toHaveBeenCalled();
    expect(stores.updateUser).not.toHaveBeenCalled();
  });

  it('rejects stale principal binding before OTP comparison', async () => {
    const f = fixture();
    f.otp.verifyAuthoritativeRecoveryBinding.mockRejectedValueOnce(new OtpInvalidError());
    await expect(f.service.reset(input, 'ip')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.otp.claimAndVerifyAttempt).not.toHaveBeenCalled();
  });

  it('rejects an incorrect OTP without expensive hashing or mutation', async () => {
    const f = fixture();
    f.otp.claimAndVerifyAttempt.mockRejectedValueOnce(new OtpInvalidError());
    await expect(f.service.reset(input, 'ip')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.passwords.hashPassword).not.toHaveBeenCalled();
    expect(f.driver.startTransaction).not.toHaveBeenCalled();
  });

  it('binds all credential writes, consumption and session revocation to a single transaction', async () => {
    const f = fixture();
    await expect(f.service.reset(input, 'ip')).resolves.toBeUndefined();
    expect(f.rateLimits.consumeOrThrow.mock.calls).toEqual([['PASSWORD_RESET_IP', 'ip'], ['PASSWORD_RESET_EMAIL', email]]);
    expect(f.otp.claimAndVerifyAttempt).toHaveBeenCalledWith(binding, challenge.challengeId, 2, input.code);
    expect(f.passwords.hashPassword).toHaveBeenCalledWith(input.newPassword);
    expect(f.passwords.hashPassword.mock.invocationCallOrder[0]).toBeLessThan(f.driver.startTransaction.mock.invocationCallOrder[0]!);
    expect(f.otp.verifyAuthoritativeRecoveryBinding).toHaveBeenLastCalledWith(expect.objectContaining({ session: f.session }));
    expect(stores.updateUser).toHaveBeenCalledWith(expect.objectContaining({ _id: userId, identityVersion: 4, accountStatus: 'ACTIVE', emailNormalized: email }), { $inc: { identityVersion: 1, sessionEpoch: 1 } }, { session: f.session });
    expect(stores.updateIdentity).toHaveBeenCalledWith({ _id: identityId, userId, provider: 'PASSWORD', subject: email }, { $set: { passwordHash: 'synthetic-new-hash' } }, { session: f.session });
    expect(f.otp.consumeVerifiedChallenge).toHaveBeenCalledWith(f.proof, f.session);
    expect(stores.updateSessions).toHaveBeenCalledWith({ userId, status: 'ACTIVE' }, expect.objectContaining({ $set: expect.objectContaining({ status: 'REVOKED', revokedReason: 'PASSWORD_RESET' }) }), { session: f.session });
    expect(f.driver.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['user', 'identity', 'challenge'])('aborts on a concurrent %s mutation', async kind => {
    const f = fixture();
    if (kind === 'user') stores.updateUser.mockReturnValue(result({ modifiedCount: 0 }));
    if (kind === 'identity') stores.updateIdentity.mockReturnValue(result({ matchedCount: 0 }));
    if (kind === 'challenge') f.otp.consumeVerifiedChallenge.mockRejectedValueOnce(new OtpInvalidError());
    await expect(f.service.reset(input, 'ip')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.driver.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.driver.commitTransaction).not.toHaveBeenCalled();
    expect(stores.updateSessions).not.toHaveBeenCalled();
  });
});

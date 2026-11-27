import type { Connection, Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPendingRegistration } from '../src/modules/identity/models/pending-registration.model.js';
import type { EmailSender } from '../src/modules/auth/email/types.js';
import type { AuthRateLimitService } from '../src/modules/auth/rate-limit/rate-limit.service.js';
import type { RateLimitPolicyName } from '../src/modules/auth/rate-limit/types.js';
import { RATE_LIMIT_POLICIES, RateLimitExceededError } from '../src/modules/auth/rate-limit/types.js';
import type { PasswordService } from '../src/modules/auth/password/password.service.js';
import { PendingRegistrationService } from '../src/modules/auth/registration/registration.service.js';
import { RegistrationWorkflow } from '../src/modules/auth/registration/workflow.js';

const lookup = vi.hoisted(() => ({
  userExists: vi.fn(),
  userExec: vi.fn(),
  inviteExists: vi.fn(),
  inviteExec: vi.fn(),
}));
vi.mock('../src/modules/identity/models/index.js', () => ({
  getUserModel: () => ({ exists: lookup.userExists }),
  getRegistrationAllowlistModel: () => ({ exists: lookup.inviteExists }),
}));

const email = 'candidate@example.test';
const ip = '203.0.113.30';
const input = { email, password: 'Valid-Password-2026!', consentVersion: 'v1' };
const requestId = '00000000-0000-4000-8000-000000000004';

function fixture(mode: 'PUBLIC' | 'INVITE_ONLY' = 'PUBLIC') {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const consume = vi.fn(async (name: RateLimitPolicyName, _subject: string) => ({
    count: 1,
    remaining: RATE_LIMIT_POLICIES[name].limit - 1,
    windowEnd: new Date(now.getTime() + RATE_LIMIT_POLICIES[name].windowMs),
  }));
  const rateLimits = { consumeOrThrow: consume } as unknown as AuthRateLimitService;
  const hash = vi.fn(async () => 'synthetic-test-hash');
  const findExec = vi.fn().mockResolvedValue(null);
  const updateExec = vi.fn().mockResolvedValue({});
  const pendingStore = {
    findOne: vi.fn().mockReturnValue({ exec: findExec }),
    create: vi.fn().mockResolvedValue({}),
    findOneAndUpdate: vi.fn().mockReturnValue({ exec: updateExec }),
  };
  const send = vi.fn<EmailSender['sendOtpEmail']>()
    .mockResolvedValue({ accepted: true, provider: 'mock' });
  const pending = new PendingRegistrationService({
    pendingRegistrationModel: pendingStore as unknown as Model<IPendingRegistration>,
    rateLimitService: rateLimits,
    passwordService: { hashPassword: hash } as unknown as PasswordService,
    emailSender: { providerName: 'mock', sendOtpEmail: send },
    hmacSecret: 'synthetic-reg-test-secret-at-least-32-bytes',
    now: () => now,
  });
  const activate = vi.fn(async () => undefined);
  const emailAvailable = vi.fn(async () => true);
  const workflow = new RegistrationWorkflow({
    connection: { readyState: 1 } as unknown as Connection,
    policy: { POLICY_CONSENT_VERSION: 'v1', REGISTRATION_MODE: mode },
    pending,
    activation: { activate },
    rateLimits,
    emailAvailable,
  });
  return {
    now, consume, hash, findExec, updateExec, pendingStore, send,
    pending, activate, emailAvailable, workflow,
  };
}

describe('P2-AUTH-03b registration admission and workflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lookup.userExists.mockReturnValue({ exec: lookup.userExec });
    lookup.userExec.mockResolvedValue(null);
    lookup.inviteExists.mockReturnValue({ exec: lookup.inviteExec });
    lookup.inviteExec.mockResolvedValue(null);
  });

  it('rejects stale consent before provider checks, abuse admission or identity lookup', async () => {
    const f = fixture();
    await expect(f.workflow.register({ ...input, consentVersion: 'stale' }, ip))
      .rejects.toMatchObject({ statusCode: 400, code: 'CONSENT_REQUIRED' });
    expect(f.emailAvailable).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(lookup.userExists).not.toHaveBeenCalled();
    expect(f.pendingStore.create).not.toHaveBeenCalled();
  });

  it('returns global provider unavailability before account lookup', async () => {
    const f = fixture();
    f.emailAvailable.mockResolvedValue(false);
    await expect(f.workflow.register(input, ip)).rejects.toMatchObject({
      statusCode: 503, code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    expect(lookup.userExists).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('uses identical durable admission and bounded hashing for known and unknown emails', async () => {
    const eligible = fixture();
    const real = await eligible.workflow.register(input, ip);
    expect(eligible.consume.mock.calls).toEqual([
      ['REGISTER_RESEND_IP', ip],
      ['REGISTER_REPLACE_COOLDOWN', email],
      ['REGISTER_RESEND_EMAIL', email],
    ]);
    expect(eligible.hash).toHaveBeenCalledWith(input.password);
    expect(eligible.hash.mock.invocationCallOrder[0])
      .toBeLessThan(lookup.userExists.mock.invocationCallOrder[0]!);
    expect(eligible.consume.mock.invocationCallOrder[2])
      .toBeLessThan(lookup.userExists.mock.invocationCallOrder[0]!);
    expect(eligible.pendingStore.create).toHaveBeenCalledTimes(1);
    expect(eligible.send).toHaveBeenCalledTimes(1);

    lookup.userExec.mockResolvedValue({ _id: 'existing-principal' });
    const ineligible = fixture();
    const decoy = await ineligible.workflow.register(input, ip);
    expect(ineligible.consume.mock.calls).toEqual(eligible.consume.mock.calls);
    expect(ineligible.hash).toHaveBeenCalledWith(input.password);
    expect(Object.keys(decoy).sort()).toEqual(Object.keys(real).sort());
    for (const result of [real, decoy]) {
      expect(result.registrationId).toMatch(/^[a-f0-9]{32}$/);
      expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(decoy.registrationId).not.toBe(real.registrationId);
    expect(ineligible.pendingStore.findOne).not.toHaveBeenCalled();
    expect(ineligible.pendingStore.create).not.toHaveBeenCalled();
    expect(ineligible.send).not.toHaveBeenCalled();
  });

  it('denies real pending work when invite-only admission is missing', async () => {
    const f = fixture('INVITE_ONLY');
    await expect(f.workflow.register(input, ip)).resolves.toMatchObject({
      registrationId: expect.any(String), nonce: expect.any(String),
    });
    expect(lookup.inviteExists).toHaveBeenCalledWith(expect.objectContaining({
      emailNormalized: email, redeemedBy: { $exists: false }, redeemedAt: { $exists: false },
    }));
    expect(f.pendingStore.create).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('does not hash or look up identity after durable admission rejects', async () => {
    const f = fixture();
    f.consume.mockRejectedValueOnce(new RateLimitExceededError(60, 'OTP_RATE_LIMITED'));
    await expect(f.workflow.register(input, ip)).rejects.toMatchObject({
      statusCode: 429, retryAfterSeconds: 60,
    });
    expect(f.hash).not.toHaveBeenCalled();
    expect(lookup.userExists).not.toHaveBeenCalled();
    expect(f.pendingStore.create).not.toHaveBeenCalled();
  });

  it('keeps provider send failure generic and marks the exact pending generation failed', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('synthetic provider detail'));
    const result = await f.workflow.register(input, ip);
    expect(Object.keys(result).sort()).toEqual(['nonce', 'registrationId']);
    expect(f.pendingStore.findOneAndUpdate).toHaveBeenCalledWith({
      registrationId: result.registrationId, version: 1, deliveryState: 'PENDING',
    }, { $set: { deliveryState: 'FAILED' } });
  });

  it('keeps response generic if recording email acceptance fails after dispatch', async () => {
    const f = fixture();
    f.updateExec.mockRejectedValueOnce(new Error('synthetic storage outage'));
    const result = await f.workflow.register(input, ip);
    expect(Object.keys(result).sort()).toEqual(['nonce', 'registrationId']);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.pendingStore.create).toHaveBeenCalledTimes(1);
  });

  it('does not resend for an account which became ineligible after registration', async () => {
    const f = fixture();
    f.findExec.mockResolvedValue({
      registrationId: 'registration', emailNormalized: email,
      consentVersion: 'v1', version: 1, otpExpiresAt: new Date(f.now.getTime() + 60_000),
      expiresAt: new Date(f.now.getTime() + 120_000),
    });
    lookup.userExec.mockResolvedValue({ _id: 'existing-principal' });
    await expect(f.workflow.resend('registration', 'nonce', ip)).resolves.toBeUndefined();
    expect(f.consume.mock.calls).toEqual([
      ['REGISTER_RESEND_IP', ip], ['REGISTER_REPLACE_COOLDOWN', email],
      ['REGISTER_RESEND_EMAIL', email],
    ]);
    expect(f.pendingStore.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('charges the IP cap for invalid browser registration cookies', async () => {
    const f = fixture();
    await expect(f.workflow.resend('registration', undefined, ip))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(f.workflow.verify('registration', undefined, '123456', ip, requestId))
      .rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(f.consume.mock.calls).toEqual([
      ['REGISTER_RESEND_IP', ip], ['VERIFY_EMAIL_IP', ip],
    ]);
    expect(f.pendingStore.findOne).not.toHaveBeenCalled();
    expect(f.pendingStore.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
  });
});

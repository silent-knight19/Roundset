import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose, { Types, type Connection } from 'mongoose';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPasswordAuthRuntime, type PasswordAuthRuntime } from '../src/modules/auth/password/runtime.js';
import { MockEmailSender } from '../src/modules/auth/email/mock-email.sender.js';
import { SessionKeyring, SessionService } from '../src/modules/auth/session/index.js';
import { ensureIdentityIndexes, verifyIdentityIndexes, getUserModel, getAuthIdentityModel, getSessionModel,
  getAuthRateLimitModel, getEmailSendBudgetModel, getPendingRegistrationModel, getVerificationChallengeModel } from '../src/modules/identity/models/index.js';
import { AuthRateLimitService } from '../src/modules/auth/rate-limit/rate-limit.service.js';
import { PendingRegistrationService } from '../src/modules/auth/registration/registration.service.js';
import { OtpChallengeService } from '../src/modules/auth/otp/otp.service.js';
import { compareDigestConstantTime } from '../src/modules/auth/otp/crypto.js';
import { createPasswordService } from '../src/modules/auth/password/password.service.js';
import { PasswordLoginService } from '../src/modules/auth/password/login.service.js';
import { PasswordRecoveryService } from '../src/modules/auth/password/recovery.service.js';
import { BudgetedEmailSender } from '../src/modules/auth/email/budgeted-email.sender.js';
import { runAuthTransaction } from '../src/modules/auth/transaction.js';
import { OtpInvalidError } from '../src/modules/auth/otp/types.js';

// Deliberately restricted to an ephemeral loopback replica-set database.
// No Atlas credentials or shared production/development database are accepted.
const enabled = process.env.RUN_AUTH_REPLICA_TESTS === 'true';
const testUri = 'mongodb://127.0.0.1:27017/roundset_test?replicaSet=rs0';
const origin = 'http://localhost:5173';

describe.skipIf(!enabled)('P2-AUTH-03b replica-set HTTP lifecycle', () => {
  let conn: Connection | undefined;
  let runtime: PasswordAuthRuntime | undefined;
  let app: ReturnType<typeof createApp>;
  const sender = new MockEmailSender({ nodeEnv: 'test', enableTestOtpCapture: true });
  const email = 'auth-' + randomBytes(12).toString('hex') + '@example.test';
  const password = 'synthetic-passphrase-123!';
  const newPassword = 'synthetic-replacement-456!';
  const env = loadEnv({
    NODE_ENV: 'test', WEB_ORIGIN: origin, AUTH_DEV_MOCK_EMAIL: 'true', MONGODB_URI: testUri,
    AUTH_CHALLENGE_HMAC_KEY: randomBytes(32).toString('hex'),
    REFRESH_HMAC_KEY: randomBytes(32).toString('hex'),
    REFRESH_DIGEST_KEY: randomBytes(32).toString('hex'),
    CSRF_HMAC_KEY: randomBytes(32).toString('hex'),
  });

  beforeAll(async () => {
    if (process.env.MONGODB_TEST_URI !== testUri) throw new Error('Only the disposable loopback replica set is permitted');
    conn = await mongoose.createConnection(testUri, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 }).asPromise();
    await ensureIdentityIndexes(conn);
    const keyring = new SessionKeyring(env);
    runtime = createPasswordAuthRuntime({ config: env, connection: conn, keyring, emailSender: sender });
    await runtime.initialize();
    await runtime.assertReady();
    app = createApp({ env, passwordAuth: runtime, sessionService: new SessionService(env, keyring, conn) });
  }, 30000);

  afterAll(async () => {
    runtime?.dispose();
    await conn?.close();
    // The CI job removes its disposable container and all test data.
  });

  it('activates once, logs in twice, resets once and revokes both sessions', async () => {
    const post = (path: string) => request(app).post('/api/v1/auth' + path).set('Origin', origin);
    const users = getUserModel(conn!);
    const identities = getAuthIdentityModel(conn!);
    const sessions = getSessionModel(conn!);
    const registration = await post('/register').send({ email, password, consentVersion: env.POLICY_CONSENT_VERSION });
    expect(registration.status).toBe(202);
    expect(await users.countDocuments({ emailNormalized: email })).toBe(0);
    const registrationId = registration.body.data.registrationId as string;
    const receipt = registration.headers['set-cookie'][0].split(';')[0];
    const code = sender.getTestOtp(registrationId);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await Promise.all([1, 2].map(() =>
      post('/verify-email').set('Cookie', receipt).send({ registrationId, code })
    ));
    expect(verified.map(res => res.status).sort()).toEqual([204, 400]);
    const user = await users.findOne({ emailNormalized: email }).orFail();
    expect(await identities.countDocuments({ userId: user._id, provider: 'PASSWORD' })).toBe(1);
    const first = await post('/login').send({ email, password });
    const second = await post('/login').send({ email, password });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await sessions.countDocuments({ userId: user._id, status: 'ACTIVE' })).toBe(2);
    const forgot = await post('/password/forgot').send({ email });
    expect(forgot.status).toBe(202);
    const record = sender.sentRecords.find(record => record.purpose === 'RESET_PASSWORD');
    expect(record).toBeDefined();
    const recoveryCode = sender.getTestOtp(record!.correlationId);
    expect(recoveryCode).toMatch(/^\d{6}$/);
    const resets = await Promise.all([1, 2].map(() =>
      post('/password/reset').send({ email, code: recoveryCode, newPassword })
    ));
    expect(resets.map(res => res.status).sort()).toEqual([204, 400]);
    const changed = await users.findById(user._id).orFail();
    expect(changed.identityVersion).toBe(user.identityVersion + 1);
    expect(changed.sessionEpoch).toBe(user.sessionEpoch + 1);
    expect(await sessions.countDocuments({ userId: user._id, status: 'REVOKED' })).toBe(2);
    const cookies = (first.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]);
    const csrf = cookies.find(value => value.startsWith('roundset_csrf='))!.split('=')[1];
    expect((await post('/refresh').set('Cookie', cookies.join('; ')).set('X-CSRF-Token', csrf).send({})).status).toBe(401);
    expect((await post('/logout-all').set('Authorization', 'Bearer ' + first.body.data.accessToken).send({})).status).toBe(401);
    expect((await post('/login').send({ email, password })).status).toBe(401);
    expect((await post('/login').send({ email, password: newPassword })).status).toBe(200);
  }, 30000);

  it('limits real concurrent OTP digest comparisons to five for both purposes', async () => {
    const secret = randomBytes(32).toString('hex');
    const testEmail = 'otp-' + randomBytes(12).toString('hex') + '@example.test';
    const rateLimits = new AuthRateLimitService({ rateLimitModel: getAuthRateLimitModel(conn!), hmacSecret: secret });
    let registrationComparisons = 0;
    const pending = new PendingRegistrationService({
      pendingRegistrationModel: getPendingRegistrationModel(conn!), rateLimitService: rateLimits,
      passwordService: createPasswordService(), emailSender: sender, hmacSecret: secret,
      compareDigest: (a, b) => { registrationComparisons++; return compareDigestConstantTime(a, b); },
    });
    const receipt = await pending.startOrReplaceRegistration({
      emailNormalized: testEmail, password, consentVersion: env.POLICY_CONSENT_VERSION, trustedIp: 'otp-test',
    });
    const code = sender.getTestOtp(receipt.registrationId)!;
    const wrong = code === '000000' ? '000001' : '000000';
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () =>
      pending.claimAndVerifyRegistrationOtp({ registrationId: receipt.registrationId, nonce: receipt.nonce, otpCode: wrong })));
    expect(attempts.every(x => x.status === 'rejected' && x.reason instanceof OtpInvalidError)).toBe(true);
    expect(registrationComparisons).toBe(5);
    await expect(pending.claimAndVerifyRegistrationOtp({ registrationId: receipt.registrationId, nonce: receipt.nonce, otpCode: code })).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(registrationComparisons).toBe(5);

    let recoveryComparisons = 0;
    const otp = new OtpChallengeService({ challengeModel: getVerificationChallengeModel(conn!), hmacSecret: secret,
      compareDigest: (a, b) => { recoveryComparisons++; return compareDigestConstantTime(a, b); } });
    const binding = { purpose: 'RESET_PASSWORD' as const, emailNormalized: testEmail, userId: new Types.ObjectId(),
      passwordIdentityIdAtIssue: new Types.ObjectId(), identityVersionAtIssue: 1 };
    const issued = await otp.issueChallenge(binding);
    await otp.markDeliveryState(issued.challengeId, issued.generation, 'ACCEPTED');
    const incorrect = issued.otpCode === '000000' ? '000001' : '000000';
    const guesses = await Promise.allSettled(Array.from({ length: 20 }, () =>
      otp.claimAndVerifyAttempt(binding, issued.challengeId, issued.generation, incorrect)));
    expect(guesses.every(x => x.status === 'rejected' && x.reason instanceof OtpInvalidError)).toBe(true);
    expect(recoveryComparisons).toBe(5);
    await expect(otp.claimAndVerifyAttempt(binding, issued.challengeId, issued.generation, issued.otpCode)).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(recoveryComparisons).toBe(5);
  }, 30000);

  it('enforces independent quota boundaries with simultaneous reservations', async () => {
    const model = getEmailSendBudgetModel(conn!);
    const dateKey = '2099-01-01';
    await model.deleteOne({ dateKey });
    await model.create({ dateKey, generalUsed: 179, recoveryUsed: 59 });
    const budgeted = new BudgetedEmailSender(model, sender, () => new Date(dateKey + 'T12:00:00Z'));
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => budgeted.sendOtpEmail({
      purpose: i < 8 ? 'REGISTER_VERIFY' : 'RESET_PASSWORD', toEmail: 'budget@example.test',
      otpCode: '123456', correlationId: 'quota-' + i, generation: 1,
    })));
    expect(results.filter(x => x.accepted)).toHaveLength(2);
    expect(results.slice(0, 8).filter(x => x.accepted)).toHaveLength(1);
    expect(results.slice(8).filter(x => x.accepted)).toHaveLength(1);
    const final = await model.findOne({ dateKey }).orFail();
    expect(final.generalUsed).toBe(180);
    expect(final.recoveryUsed).toBe(60);
  });

  it('normalizes real and decoy resend admission while only delivering for the genuine record', async () => {
    const secret = randomBytes(32).toString('hex');
    let clock = Date.now();
    const rateLimits = new AuthRateLimitService({ rateLimitModel: getAuthRateLimitModel(conn!), hmacSecret: secret, now: () => new Date(clock) });
    const pending = new PendingRegistrationService({
      pendingRegistrationModel: getPendingRegistrationModel(conn!), rateLimitService: rateLimits,
      passwordService: createPasswordService(), emailSender: sender, hmacSecret: secret, now: () => new Date(clock),
    });
    const input = { password, consentVersion: env.POLICY_CONSENT_VERSION, trustedIp: 'resend-test' };
    const real = await pending.startOrReplaceRegistration({ ...input, emailNormalized: 'real-' + randomBytes(12).toString('hex') + '@example.test' }, async () => true);
    const decoy = await pending.startOrReplaceRegistration({ ...input, emailNormalized: 'decoy-' + randomBytes(12).toString('hex') + '@example.test' }, async () => false);
    for (const receipt of [real, decoy]) {
      await expect(pending.resendRegistrationOtp({ ...receipt, trustedIp: 'resend-test' }, async () => true)).rejects.toMatchObject({ statusCode: 429 });
    }
    clock += 61_000;
    const realResult = await pending.resendRegistrationOtp({ ...real, trustedIp: 'resend-test' }, async () => true);
    const decoyResult = await pending.resendRegistrationOtp({ ...decoy, trustedIp: 'resend-test' }, async () => false);
    expect(realResult.deliveryAccepted).toBe(true);
    expect(decoyResult.deliveryAccepted).toBe(false);
    expect(await getPendingRegistrationModel(conn!).countDocuments({ registrationId: decoy.registrationId })).toBe(0);
    expect(sender.sentRecords.filter(x => x.correlationId === real.registrationId)).toHaveLength(2);
    expect(sender.sentRecords.filter(x => x.correlationId === decoy.registrationId)).toHaveLength(0);
  });

  it('rejects a login whose proven password is replaced before session issuance', async () => {
    const users = getUserModel(conn!);
    const identities = getAuthIdentityModel(conn!);
    const sessions = getSessionModel(conn!);
    const subject = await users.findOne({ emailNormalized: email }).orFail();
    const secret = randomBytes(32).toString('hex');
    const passwords = createPasswordService();
    const rateLimits = new AuthRateLimitService({ rateLimitModel: getAuthRateLimitModel(conn!), hmacSecret: secret });
    const otp = new OtpChallengeService({ challengeModel: getVerificationChallengeModel(conn!), hmacSecret: secret });
    const recovery = new PasswordRecoveryService({ connection: conn!, passwords, otp, rateLimits, emailSender: sender,
      hmacSecret: secret, emailAvailable: () => true });
    await recovery.forgot({ email }, 'race-forgot');
    const record = sender.sentRecords.filter(x => x.purpose === 'RESET_PASSWORD').at(-1)!;
    const recoveryCode = sender.getTestOtp(record.correlationId)!;
    const verify = passwords.verifyPassword.bind(passwords);
    passwords.verifyPassword = async (candidate, hash) => {
      const valid = await verify(candidate, hash);
      if (valid) await recovery.reset({ email, code: recoveryCode, newPassword: 'third-synthetic-password!' }, 'race-reset');
      return valid;
    };
    const keyring = new SessionKeyring(env);
    const login = new PasswordLoginService({ connection: conn!, config: env, keyring, passwords, rateLimits });
    const previousCount = await sessions.countDocuments({ userId: subject._id });
    await expect(login.login({ email, password: newPassword }, 'race-login', '00000000-0000-4000-8000-000000000005', false))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await sessions.countDocuments({ userId: subject._id })).toBe(previousCount);
    expect(await sessions.countDocuments({ userId: subject._id, status: 'ACTIVE' })).toBe(0);
    const credential = await identities.findOne({ userId: subject._id, provider: 'PASSWORD' }).orFail();
    expect(await verify('third-synthetic-password!', credential.passwordHash)).toBe(true);
  }, 30000);

  it('rolls back real database writes when a later step rejects', async () => {
    const model = getEmailSendBudgetModel(conn!);
    const dateKey = '2099-01-02';
    await model.deleteOne({ dateKey });
    await expect(runAuthTransaction(conn!, async session => {
      await model.create([{ dateKey, generalUsed: 1, recoveryUsed: 0 }], { session });
      throw new OtpInvalidError();
    })).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(await model.countDocuments({ dateKey })).toBe(0);
  });

  it('samples local known and unknown forgot-password response durations', async () => {
    const samples: Record<string, number[]> = { known: [], unknown: [] };
    const known = [email, email];
    for (let i = 0; i < known.length; i++) {
      for (const [kind, address] of [['known', known[i]!], ['unknown', 'missing-' + randomBytes(12).toString('hex') + '@example.test']] as const) {
        const start = performance.now();
        const response = await request(app).post('/api/v1/auth/password/forgot').set('Origin', origin).send({ email: address });
        samples[kind]!.push(performance.now() - start);
        expect(response.status).toBe(202);
        expect(response.body.data).toEqual({ message: 'If eligible, a verification code may be sent.' });
      }
    }
    expect([...samples.known!, ...samples.unknown!].every(ms => ms >= 290)).toBe(true);
    // Observations only, not a statistical equivalence claim or real-provider evidence.
    console.log('Local mock recovery latency samples (ms):', JSON.stringify(samples));
  });

  it('rejects a partial unique index substituted for an unconditional index', async () => {
    const model = getAuthRateLimitModel(conn!);
    const original = (await model.collection.indexes()).find(i => i.key.bucketKey === 1);
    expect(original?.name).toBeDefined();
    await model.collection.dropIndex(original!.name!);
    try {
      await model.collection.createIndex({ bucketKey: 1 }, { unique: true, partialFilterExpression: { count: { $gt: 10 } }, name: 'unsafe_partial_test' });
      const verification = await verifyIdentityIndexes(conn!);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.includes('authRateLimits') && issue.includes('index options mismatch'))).toBe(true);
      const otherRuntime = createPasswordAuthRuntime({ config: env, connection: conn!, keyring: new SessionKeyring(env), emailSender: sender });
      try {
        await otherRuntime.initialize();
        await expect(otherRuntime.assertReady()).rejects.toMatchObject({ statusCode: 503 });
      } finally { otherRuntime.dispose(); }
    } finally {
      await model.collection.dropIndex('unsafe_partial_test');
      await model.collection.createIndex({ bucketKey: 1 }, { unique: true, name: original!.name });
    }
  }, 30000);
});

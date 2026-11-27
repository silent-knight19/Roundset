import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose, { type Connection } from 'mongoose';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPasswordAuthRuntime, type PasswordAuthRuntime } from '../src/modules/auth/password/runtime.js';
import { MockEmailSender } from '../src/modules/auth/email/mock-email.sender.js';
import { SessionKeyring, SessionService } from '../src/modules/auth/session/index.js';
import { ensureIdentityIndexes, getUserModel, getAuthIdentityModel, getSessionModel } from '../src/modules/identity/models/index.js';

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
    NODE_ENV: 'test', WEB_ORIGIN: origin, AUTH_DEV_MOCK_EMAIL: 'true',
    AUTH_CHALLENGE_HMAC_KEY: randomBytes(32).toString('hex'),
    REFRESH_HMAC_KEY: randomBytes(32).toString('hex'),
    REFRESH_DIGEST_KEY: randomBytes(32).toString('hex'),
    CSRF_HMAC_KEY: randomBytes(32).toString('hex'),
  });

  beforeAll(async () => {
    if (process.env.MONGODB_TEST_URI !== testUri) throw new Error('Only the disposable loopback replica set is permitted');
    conn = await mongoose.createConnection(testUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
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
    expect((await post('/login').send({ email, password })).status).toBe(401);
    expect((await post('/login').send({ email, password: newPassword })).status).toBe(200);
  }, 30000);
});

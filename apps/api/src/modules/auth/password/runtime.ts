import type { Connection } from 'mongoose';
import { isIsolatedMockAuthConfig, type AppConfig } from '../../../config/env.js';
import { ServiceUnavailableError } from '../../../core/errors.js';
import type { PasswordAuthRouteServices } from '../../../routes/password-auth.js';
import {
  getAuthRateLimitModel, getEmailSendBudgetModel, getPendingRegistrationModel,
  getVerificationChallengeModel, verifyIdentityIndexes,
} from '../../identity/models/index.js';
import type { EmailSender } from '../email/types.js';
import { BudgetedEmailSender } from '../email/budgeted-email.sender.js';
import { OtpChallengeService } from '../otp/otp.service.js';
import { AuthRateLimitService } from '../rate-limit/rate-limit.service.js';
import { PendingRegistrationService } from '../registration/registration.service.js';
import { RegistrationActivationService } from '../registration/activation.service.js';
import { RegistrationWorkflow } from '../registration/workflow.js';
import type { SessionKeyring } from '../session/keyring.js';
import { PasswordLoginService } from './login.service.js';
import { PasswordRecoveryService } from './recovery.service.js';
import { createPasswordService } from './password.service.js';

export interface PasswordAuthRuntime extends PasswordAuthRouteServices {
  initialize(): Promise<void>;
  dispose(): void;
}

/**
 * One shared bounded password service and stable configured HMAC key.
 * This ticket enables only local mock-email integration; a production provider
 * must pass its separate release gate before these routes may be activated.
 */
export function createPasswordAuthRuntime(options: {
  config: AppConfig;
  connection: Connection;
  keyring: SessionKeyring;
  emailSender: EmailSender;
}): PasswordAuthRuntime {
  const { config, connection, keyring } = options;
  if (!isIsolatedMockAuthConfig(config) || options.emailSender.providerName !== 'mock') {
    throw new Error('Password authentication runtime requires local real-database/mock-email mode');
  }
  const hmacSecret = config.AUTH_CHALLENGE_HMAC_KEY;
  if (!hmacSecret) throw new Error('AUTH_CHALLENGE_HMAC_KEY is required');

  const passwords = createPasswordService();
  const rateLimits = new AuthRateLimitService({
    rateLimitModel: getAuthRateLimitModel(connection), hmacSecret,
  });
  const emailSender = new BudgetedEmailSender(getEmailSendBudgetModel(connection), options.emailSender);
  const pending = new PendingRegistrationService({
    pendingRegistrationModel: getPendingRegistrationModel(connection),
    rateLimitService: rateLimits, passwordService: passwords, emailSender, hmacSecret,
  });
  const activation = new RegistrationActivationService({
    connection, pendingRegistrationService: pending, policy: config,
  });
  const otp = new OtpChallengeService({
    challengeModel: getVerificationChallengeModel(connection), hmacSecret,
  });

  let initialized = false;
  let disposed = false;
  let generation = 0;
  let lastCheck: { ok: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  function invalidate(): void {
    generation += 1;
    lastCheck = null;
    inFlight = null;
  }
  connection.on('connected', invalidate);
  connection.on('disconnected', invalidate);

  async function checkDatabase(): Promise<boolean> {
    try {
      const hello = await connection.db?.admin().command({ hello: 1, maxTimeMS: 5000 });
      if (connection.name !== 'roundset_test' || (connection.host !== '127.0.0.1' && connection.host !== 'localhost') ||
          hello?.setName !== 'rs0' || hello.logicalSessionTimeoutMinutes == null ||
          !Array.isArray(hello.hosts) || hello.hosts.some((host: unknown) => typeof host !== 'string' || !/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host))) return false;
      return (await verifyIdentityIndexes(connection)).ok;
    } catch {
      return false;
    }
  }

  async function assertReady(): Promise<void> {
    if (!initialized || disposed || connection.readyState !== 1) {
      throw new ServiceUnavailableError('Password authentication is unavailable');
    }
    // Bounded cache for the development-only runtime; refresh on reconnect.
    // Failed checks are briefly cached too, preventing an index-scan flood.
    const now = Date.now();
    if (!lastCheck || now - lastCheck.at >= 30_000) {
      if (!inFlight) {
        const epoch = generation;
        const check = checkDatabase().then(ok => {
          if (generation !== epoch || disposed) return false;
          lastCheck = { ok, at: Date.now() };
          return ok;
        }).finally(() => {
          if (inFlight === check) inFlight = null;
        });
        inFlight = check;
      }
      if (!(await inFlight)) throw new ServiceUnavailableError('Authentication database is not ready');
    } else if (!lastCheck.ok) {
      throw new ServiceUnavailableError('Authentication database is not ready');
    }
    if (disposed || connection.readyState !== 1 || !lastCheck?.ok) {
      throw new ServiceUnavailableError('Authentication database is not ready');
    }
  }

  return {
    registration: new RegistrationWorkflow({ connection, policy: config, pending, activation, rateLimits, emailAvailable: () => true }),
    login: new PasswordLoginService({ connection, config, keyring, passwords, rateLimits }),
    recovery: new PasswordRecoveryService({ connection, passwords, otp, rateLimits, emailSender, hmacSecret, emailAvailable: () => true }),
    async initialize() {
      // Warm the dummy hash before accepting traffic; no per-route service.
      await keyring.ensureInitialized();
      await passwords.verifyDummy('roundset-startup-warmup');
      initialized = true;
    },
    assertReady,
    dispose() {
      disposed = true;
      invalidate();
      connection.removeListener('connected', invalidate);
      connection.removeListener('disconnected', invalidate);
    },
  };
}

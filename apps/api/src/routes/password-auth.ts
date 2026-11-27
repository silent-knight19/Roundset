import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import type { z } from 'zod';
import {
  RegisterRequestSchema, RegisterResponseSchema, VerifyEmailRequestSchema,
  ResendOtpRequestSchema, LoginRequestSchema, SessionResponseSchema,
  PasswordForgotRequestSchema, PasswordResetRequestSchema, GenericMessageResponseSchema,
} from '@roundset/contracts';
import { InvalidInputError, ServiceUnavailableError } from '../core/errors.js';
import { getRequestId } from '../core/request-id.js';
import { withAuthDiagnostics } from '../modules/auth/diagnostics.js';
import type { PasswordLoginService } from '../modules/auth/password/login.service.js';
import type { PasswordRecoveryService } from '../modules/auth/password/recovery.service.js';
import type { RegistrationWorkflow } from '../modules/auth/registration/workflow.js';
import {
  parseRegistrationCookie, serializeRegistrationCookie, serializeClearRegistrationCookie,
} from '../modules/auth/registration/cookies.js';
import { createOriginAndFetchMetadataMiddleware } from '../modules/auth/session/middleware.js';
import { createFloodShedderMiddleware } from '../modules/auth/rate-limit/flood-shedder.js';
import { extractTrustedClientIp, RateLimitExceededError } from '../modules/auth/rate-limit/types.js';

export interface PasswordAuthRouteServices {
  registration: Pick<RegistrationWorkflow, 'register' | 'resend' | 'verify'>;
  login: Pick<PasswordLoginService, 'login'>;
  recovery: Pick<PasswordRecoveryService, 'forgot' | 'reset'>;
  assertReady(): Promise<void>;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new InvalidInputError('Invalid authentication request');
  return parsed.data;
}

// Initial local-only floor. Real delivery remains disabled until a measured
// provider/DB distribution and bounded timeouts justify a release threshold.
const LOCAL_RESPONSE_FLOOR_MS = 300;
async function withResponseFloor<T>(work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally {
    const remaining = LOCAL_RESPONSE_FLOOR_MS - (performance.now() - start);
    if (remaining > 0) await sleep(Math.ceil(remaining));
  }
}

const genericMessage = 'If eligible, a verification code may be sent.';
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createPasswordAuthRouter(options: {
  allowedOrigin: string;
  isProduction: boolean;
  services?: PasswordAuthRouteServices;
}): Router {
  const router = Router();
  const { allowedOrigin, isProduction, services } = options;
  const origin = createOriginAndFetchMetadataMiddleware(allowedOrigin);
  const flood = createFloodShedderMiddleware();

  // Keep slots until work actually settles, including if a client disconnects.
  // Never race a response timeout against an in-flight credential mutation.
  let activeRequests = 0;
  function bounded(handler: RequestHandler): RequestHandler {
    return async (req, res, next) => {
      if (activeRequests >= 12) throw new ServiceUnavailableError('Authentication capacity exhausted');
      activeRequests += 1;
      try {
        await withAuthDiagnostics(getRequestId(res, req), req.log, async () => {
          await handler(req, res, next);
        });
      } finally { activeRequests -= 1; }
    };
  }

  async function ready(): Promise<PasswordAuthRouteServices> {
    if (isProduction || !services) throw new ServiceUnavailableError('Password authentication is unavailable');
    await services.assertReady();
    return services;
  }

  router.post('/register', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(RegisterRequestSchema, req.body);
    const svc = await ready();
    const result = await withResponseFloor(() => svc.registration.register(input, extractTrustedClientIp(req)));
    const response = RegisterResponseSchema.parse({
      data: { registrationId: result.registrationId, message: genericMessage },
      meta: { requestId: getRequestId(res, req) },
    });
    res.setHeader('Set-Cookie', serializeRegistrationCookie(result.registrationId, result.nonce, {
      isProduction, isSecure: req.secure,
    }));
    res.status(202).json(response);
  }));

  router.post('/otp/resend', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(ResendOtpRequestSchema, req.body);
    const svc = await ready();
    const cookie = parseRegistrationCookie(req.headers.cookie, { isProduction });
    const nonce = cookie?.registrationId === input.registrationId ? cookie.nonce : undefined;
    await withResponseFloor(() => svc.registration.resend(input.registrationId, nonce, extractTrustedClientIp(req)));
    res.status(202).json(GenericMessageResponseSchema.parse({
      data: { message: genericMessage }, meta: { requestId: getRequestId(res, req) },
    }));
  }));

  router.post('/verify-email', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(VerifyEmailRequestSchema, req.body);
    const svc = await ready();
    const cookie = parseRegistrationCookie(req.headers.cookie, { isProduction });
    const nonce = cookie?.registrationId === input.registrationId ? cookie.nonce : undefined;
    await svc.registration.verify(input.registrationId, nonce, input.code, extractTrustedClientIp(req), getRequestId(res, req));
    res.setHeader('Set-Cookie', serializeClearRegistrationCookie({ isProduction, isSecure: req.secure }));
    res.status(204).end();
  }));

  router.post('/login', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(LoginRequestSchema, req.body);
    const svc = await ready();
    const result = await svc.login.login(input, extractTrustedClientIp(req), getRequestId(res, req), req.secure);
    const body = SessionResponseSchema.parse(result.sessionResponse);
    res.setHeader('Set-Cookie', result.setCookieHeaders);
    res.status(200).json(body);
  }));

  router.post('/password/forgot', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(PasswordForgotRequestSchema, req.body);
    const svc = await ready();
    await withResponseFloor(() => svc.recovery.forgot(input, extractTrustedClientIp(req)));
    res.status(202).json(GenericMessageResponseSchema.parse({
      data: { message: genericMessage }, meta: { requestId: getRequestId(res, req) },
    }));
  }));

  router.post('/password/reset', noStore, origin, flood, bounded(async (req, res) => {
    const input = parse(PasswordResetRequestSchema, req.body);
    const svc = await ready();
    await svc.recovery.reset(input, extractTrustedClientIp(req));
    // All affected sessions are invalidated durably; do not clear cookies
    // that might belong to an unrelated currently signed-in principal.
    res.status(204).end();
  }));

  const rateLimitHeaders: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof RateLimitExceededError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    next(error);
  };
  router.use(rateLimitHeaders);
  return router;
}

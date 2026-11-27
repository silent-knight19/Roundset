import { Router } from 'express';
import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from '@roundset/contracts';
import type { ReadinessProvider } from '../core/readiness.js';
import { getRequestId } from '../core/request-id.js';
import type { SessionService } from '../modules/auth/session/session.service.js';
import { createAuthRouter } from './auth.js';
import type { PasswordAuthRouteServices } from './password-auth.js';

export interface RouteOptions {
  readinessProvider: ReadinessProvider;
  version?: string;
  sessionService?: SessionService;
  allowedOrigin?: string;
  isProduction?: boolean;
  passwordAuth?: PasswordAuthRouteServices;
}

/**
 * Creates the API v1 router containing health, auth and core endpoints.
 */
export function createV1Router(options: RouteOptions): Router {
  const router = Router();
  const apiVersion = options.version ?? '0.1.0';

  // GET /api/v1/health/live
  router.get('/health/live', (req, res) => {
    const requestId = getRequestId(res, req);
    const body = LivenessResponseSchema.parse({
      data: {
        status: 'ok',
        version: apiVersion,
      },
      meta: {
        requestId,
      },
    });

    res.status(200).json(body);
  });

  // GET /api/v1/health/ready
  router.get('/health/ready', async (req, res) => {
    const requestId = getRequestId(res, req);
    const isReady = Boolean(await options.readinessProvider.isReady());

    const body = ReadinessResponseSchema.parse({
      data: {
        ready: isReady,
      },
      meta: {
        requestId,
      },
    });

    res.status(isReady ? 200 : 503).json(body);
  });

  // Mount auth routes if sessionService is provided
  if (options.sessionService && options.allowedOrigin) {
    router.use(
      '/auth',
      createAuthRouter({
        sessionService: options.sessionService,
        allowedOrigin: options.allowedOrigin,
        isProduction: options.isProduction,
        passwordAuth: options.passwordAuth,
      })
    );
  }

  return router;
}

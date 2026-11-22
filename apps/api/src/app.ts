import express, { Express, Router } from 'express';
import type { Logger } from 'pino';
import { loadEnv, type AppConfig } from './config/env.js';
import { requestIdMiddleware } from './core/request-id.js';
import {
  createHelmetMiddleware,
  createCorsMiddleware,
  createOriginValidationMiddleware,
  JSON_BODY_LIMIT_BYTES,
} from './core/security.js';
import { createLogger, createHttpLogger } from './core/logging.js';
import { createErrorHandler, notFoundHandler } from './core/errors.js';
import { MockReadinessProvider, type ReadinessProvider } from './core/readiness.js';
import { createIngressMiddleware } from './core/ingress.js';
import { SessionKeyring, SessionService } from './modules/auth/session/index.js';
import { createV1Router } from './routes/index.js';

export interface CreateAppOptions {
  env?: AppConfig;
  readinessProvider?: ReadinessProvider;
  logger?: Logger;
  extraRouter?: Router;
  sessionService?: SessionService;
}

/**
 * Express application factory.
 * Pure factory: Does not bind a TCP port or initiate database connections.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.env ?? loadEnv();
  const logger = options.logger ?? createLogger();
  const readinessProvider = options.readinessProvider ?? new MockReadinessProvider(false);

  const keyring = new SessionKeyring(config);
  const sessionService =
    options.sessionService ?? new SessionService(config, keyring);

  const app = express();

  // 1. Trust proxy configuration:
  // In PAGES_PROXY mode, express trust proxy is set to 0 to prevent trusting raw XFF.
  const trustProxyHops = config.INGRESS_MODE === 'PAGES_PROXY' ? 0 : config.TRUST_PROXY_HOPS;
  app.set('trust proxy', trustProxyHops);
  app.disable('x-powered-by');

  // 2. Request ID generation
  app.use(requestIdMiddleware);

  // 3. Security headers via Helmet
  app.use(createHelmetMiddleware());

  // 4. Ingress and proxy verification (LOCAL, PAGES_PROXY, SINGLE_ORIGIN)
  app.use(createIngressMiddleware(config));

  // 5. Origin validation and CORS for configured browser origin
  app.use(createOriginValidationMiddleware(config.WEB_ORIGIN));
  app.use(createCorsMiddleware(config.WEB_ORIGIN));

  // 6. Structured HTTP logging
  app.use(createHttpLogger(logger));

  // 7. JSON body parsing bounded at 64 KiB
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

  // 8. Mount extra test router if injected (only during tests)
  if (options.extraRouter) {
    app.use('/api/v1', options.extraRouter);
  }

  // 9. Core API v1 routes (health and auth)
  app.use(
    '/api/v1',
    createV1Router({
      readinessProvider,
      sessionService,
      allowedOrigin: config.WEB_ORIGIN,
      isProduction: config.NODE_ENV === 'production',
    })
  );

  // 10. Centralized 404 handler for unknown routes
  app.use(notFoundHandler);

  // 11. Centralized Express 5 error handler
  app.use(createErrorHandler(logger));

  return app;
}

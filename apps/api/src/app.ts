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
import { createV1Router } from './routes/index.js';

export interface CreateAppOptions {
  env?: AppConfig;
  readinessProvider?: ReadinessProvider;
  logger?: Logger;
  extraRouter?: Router;
}

/**
 * Express application factory.
 * Pure factory: Does not bind a TCP port or initiate database connections.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.env ?? loadEnv();
  const logger = options.logger ?? createLogger();
  const readinessProvider = options.readinessProvider ?? new MockReadinessProvider(false);

  const app = express();

  // 1. Trust proxy configuration
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  // 2. Request ID generation
  app.use(requestIdMiddleware);

  // 3. Security headers via Helmet
  app.use(createHelmetMiddleware());

  // 4. Origin validation and CORS for configured browser origin
  app.use(createOriginValidationMiddleware(config.WEB_ORIGIN));
  app.use(createCorsMiddleware(config.WEB_ORIGIN));

  // 5. Structured HTTP logging
  app.use(createHttpLogger(logger));

  // 6. JSON body parsing bounded at 64 KiB
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

  // 7. Mount extra test router if injected (only during tests)
  if (options.extraRouter) {
    app.use('/api/v1', options.extraRouter);
  }

  // 8. Core API v1 routes
  app.use('/api/v1', createV1Router({ readinessProvider }));

  // 9. Centralized 404 handler for unknown routes
  app.use(notFoundHandler);

  // 10. Centralized Express 5 error handler
  app.use(createErrorHandler(logger));

  return app;
}

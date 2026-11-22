import type { Request, Response, NextFunction, RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ForbiddenError } from './errors.js';

export const JSON_BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB = 65,536 bytes

export interface SecurityOptions {
  allowedOrigin: string;
}

/**
 * Validates request Origin against configured WEB_ORIGIN.
 * Rejects unapproved origins with HTTP 403 Forbidden.
 * Requests without an Origin header are permitted for CLI/health monitors.
 */
export function createOriginValidationMiddleware(allowedOrigin: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) {
      // Allow requests without Origin header (e.g. server-to-server, health probes, CLI)
      return next();
    }

    if (origin !== allowedOrigin) {
      return next(new ForbiddenError('Forbidden origin'));
    }

    next();
  };
}

/**
 * Creates Helmet middleware configured with safe defaults for API responses.
 */
export function createHelmetMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Creates standard CORS middleware for approved browser origin.
 */
export function createCorsMiddleware(allowedOrigin: string): RequestHandler {
  return cors({
    origin: allowedOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-ID'],
  });
}

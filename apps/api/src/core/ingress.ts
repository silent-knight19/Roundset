import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AppConfig } from '../config/env.js';
import { ForbiddenError } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      clientIp?: string;
    }
  }
}

/**
 * Checks whether the incoming path is an exempt public health check endpoint.
 * Health endpoints must remain functional without Origin or edge headers.
 */
export function isHealthEndpoint(path: string): boolean {
  return (
    path === '/health/live' ||
    path === '/health/ready' ||
    path === '/api/v1/health/live' ||
    path === '/api/v1/health/ready'
  );
}

/**
 * Constant-time comparison between incoming secret and expected secret.
 */
export function compareSecretConstantTime(incoming: string, expected: string): boolean {
  const incomingBuf = Buffer.from(incoming, 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');

  if (incomingBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(incomingBuf, expectedBuf);
}

/**
 * Ingress and proxy security middleware enforcing the approved LOCAL, PAGES_PROXY,
 * and SINGLE_ORIGIN modes.
 */
export function createIngressMiddleware(config: AppConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // 1. Health endpoints are exempt from edge authentication
    if (isHealthEndpoint(req.path)) {
      return next();
    }

    // 2. Reject LOCAL ingress mode in production
    if (config.NODE_ENV === 'production' && config.INGRESS_MODE === 'LOCAL') {
      return next(new ForbiddenError('LOCAL ingress mode is forbidden in production'));
    }

    // 3. PAGES_PROXY mode enforcement
    if (config.INGRESS_MODE === 'PAGES_PROXY') {
      const edgeAuthHeader = req.headers['x-roundset-edge-auth'];

      if (!edgeAuthHeader || typeof edgeAuthHeader !== 'string') {
        return next(new ForbiddenError('Edge authentication required'));
      }

      const currentSecret = config.EDGE_AUTH_SECRET_CURRENT;
      const previousSecret = config.EDGE_AUTH_SECRET_PREVIOUS;

      let isMatch = false;
      if (currentSecret && compareSecretConstantTime(edgeAuthHeader, currentSecret)) {
        isMatch = true;
      } else if (previousSecret && compareSecretConstantTime(edgeAuthHeader, previousSecret)) {
        isMatch = true;
      }

      if (!isMatch) {
        return next(new ForbiddenError('Invalid edge authentication'));
      }

      // In PAGES_PROXY mode, extract client IP exclusively from trusted edge header X-Roundset-Client-IP
      const clientIpHeader = req.headers['x-roundset-client-ip'];
      if (typeof clientIpHeader === 'string' && clientIpHeader.trim().length > 0) {
        req.clientIp = clientIpHeader.trim();
      } else {
        req.clientIp = req.socket.remoteAddress;
      }

      return next();
    }

    // 4. SINGLE_ORIGIN mode
    if (config.INGRESS_MODE === 'SINGLE_ORIGIN') {
      req.clientIp = req.socket.remoteAddress;
      return next();
    }

    // 5. LOCAL mode (dev / test)
    req.clientIp = req.socket.remoteAddress;
    next();
  };
}

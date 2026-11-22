import { Router } from 'express';
import {
  AuthMetaResponseSchema,
  SessionResponseSchema,
} from '@roundset/contracts';
import type { SessionService } from '../modules/auth/session/session.service.js';
import {
  parseCookies,
  extractRefreshCookie,
  extractCsrfCookie,
  serializeClearCookies,
} from '../modules/auth/session/cookies.js';
import { createOriginAndFetchMetadataMiddleware } from '../modules/auth/session/middleware.js';
import { getRequestId } from '../core/request-id.js';
import { InvalidInputError } from '../core/errors.js';

function validateStrictEmptyObjectBody(body: unknown): void {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    throw new InvalidInputError('Request body must be an empty JSON object {}');
  }
}

export interface AuthRouteOptions {
  sessionService: SessionService;
  allowedOrigin: string;
  isProduction?: boolean;
}

export function createAuthRouter(options: AuthRouteOptions): Router {
  const router = Router();
  const { sessionService, allowedOrigin, isProduction = false } = options;

  // Origin & Fetch Metadata middleware for protected auth routes
  const requireOrigin = createOriginAndFetchMetadataMiddleware(allowedOrigin);

  // GET /api/v1/auth/meta (Public)
  router.get('/meta', (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const requestId = getRequestId(res, req);
      const metaResponse = sessionService.getMeta(requestId);
      const body = AuthMetaResponseSchema.parse(metaResponse);
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/refresh (Cookie + CSRF + Origin)
  router.post('/refresh', requireOrigin, async (req, res, next) => {
    try {
      validateStrictEmptyObjectBody(req.body);
      res.setHeader('Cache-Control', 'no-store');
      const requestId = getRequestId(res, req);

      const cookies = parseCookies(req.headers.cookie);
      const rawRefreshToken = extractRefreshCookie(cookies, { isProduction });
      const csrfCookie = extractCsrfCookie(cookies, { isProduction });
      const csrfHeader = req.headers['x-csrf-token'] as string | undefined;

      const { sessionResponse, setCookieHeaders } = await sessionService.rotateSession({
        rawRefreshToken,
        csrfHeader,
        csrfCookie,
        isSecure: req.secure,
        requestId,
      });

      const validatedBody = SessionResponseSchema.parse(sessionResponse);

      // Two separate Set-Cookie headers
      res.setHeader('Set-Cookie', setCookieHeaders);
      res.status(200).json(validatedBody);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/logout (Cookie + CSRF OR Bearer-only)
  router.post('/logout', requireOrigin, async (req, res, next) => {
    try {
      validateStrictEmptyObjectBody(req.body);
      res.setHeader('Cache-Control', 'no-store');
      const requestId = getRequestId(res, req);

      const cookies = parseCookies(req.headers.cookie);
      const rawRefreshToken = extractRefreshCookie(cookies, { isProduction });
      const csrfCookie = extractCsrfCookie(cookies, { isProduction });
      const csrfHeader = req.headers['x-csrf-token'] as string | undefined;

      let bearerToken: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.substring(7).trim();
      }

      const { clearCookies } = await sessionService.logout({
        rawRefreshToken,
        csrfHeader,
        csrfCookie,
        bearerToken,
        isSecure: req.secure,
        requestId,
      });

      if (clearCookies) {
        const clearHeaders = serializeClearCookies({
          isSecure: req.secure,
          isProduction,
        });
        res.setHeader('Set-Cookie', clearHeaders);
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/logout-all (Bearer + Origin)
  router.post('/logout-all', requireOrigin, async (req, res, next) => {
    try {
      validateStrictEmptyObjectBody(req.body);
      res.setHeader('Cache-Control', 'no-store');
      const requestId = getRequestId(res, req);

      let bearerToken: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.substring(7).trim();
      }

      await sessionService.logoutAll({
        bearerToken,
        requestId,
      });

      // Clear any cookies on the client
      const clearHeaders = serializeClearCookies({
        isSecure: req.secure,
        isProduction,
      });
      res.setHeader('Set-Cookie', clearHeaders);

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

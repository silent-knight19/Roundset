import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

/**
 * Middleware that generates an unforgeable server-side UUID for every request.
 * Client-provided request IDs are intentionally ignored to prevent spoofing.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}

/**
 * Retrieves the current request ID from Express response locals or request object.
 */
export function getRequestId(res?: Response, req?: Request): string {
  if (res?.locals?.requestId && typeof res.locals.requestId === 'string') {
    return res.locals.requestId;
  }
  if (req?.id && typeof req.id === 'string') {
    return req.id;
  }
  return randomUUID();
}

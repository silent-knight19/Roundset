import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SessionService } from './session.service.js';
import { UnauthorizedError, ForbiddenError } from '../../../core/errors.js';
import { getUserModel, getSessionModel, type IUser, type ISession } from '../../identity/models/index.js';

// Extend Express Request interface for typed user and session
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: IUser;
      session?: ISession;
    }
  }
}

export function createBearerAuthMiddleware(sessionService: SessionService): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedError('Bearer authentication required');
      }

      const token = authHeader.substring(7).trim();
      const payload = await sessionService.keyring
        ? await (await import('./jwt.js')).verifyAccessToken(sessionService.keyring, token)
        : null;

      if (!payload) {
        throw new UnauthorizedError('Invalid access token');
      }

      const now = new Date();
      const UserModel = getUserModel();
      const SessionModel = getSessionModel();

      // Verify persistent user status and session epoch
      const user = await UserModel.findById(payload.sub);
      if (!user || user.accountStatus !== 'ACTIVE') {
        throw new UnauthorizedError('User account not active');
      }

      if (user.sessionEpoch !== payload.epoch) {
        throw new UnauthorizedError('Session epoch mismatch');
      }

      // Verify persistent session status and expiry
      const session = await SessionModel.findOne({ sessionId: payload.sid });
      if (!session || session.status !== 'ACTIVE') {
        throw new UnauthorizedError('Session not active');
      }

      if (now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) {
        throw new UnauthorizedError('Session has expired');
      }

      req.user = user.toObject();
      req.session = session.toObject();
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function createOriginAndFetchMetadataMiddleware(allowedOrigin: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // 1. Fetch Metadata check: reject cross-site requests
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site') {
      return next(new ForbiddenError('Cross-site requests forbidden'));
    }

    // 2. Strict Origin check
    const origin = req.headers.origin;
    if (!origin) {
      return next(new ForbiddenError('Origin header required'));
    }

    if (origin !== allowedOrigin) {
      return next(new ForbiddenError('Forbidden origin'));
    }

    next();
  };
}

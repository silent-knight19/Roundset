import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { getRequestId } from './request-id.js';

/**
 * Base custom HTTP error carrying status code and standardized error code.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class InvalidInputError extends HttpError {
  constructor(message = 'Invalid input') {
    super(400, 'INVALID_INPUT', message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message = 'Payload too large') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/**
 * Handler for 404 Not Found responses across unmapped endpoints.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = getRequestId(res, req);
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Not found',
      requestId,
    },
  });
}

/**
 * Creates an Express 5 centralized error handling middleware.
 */
export function createErrorHandler(logger?: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = getRequestId(res, req);

    // 1. Custom application HttpError
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          requestId,
        },
      });
      return;
    }

    // 2. Body-parser malformed JSON or parsing errors
    const errObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
    const isMalformedJson =
      (err instanceof SyntaxError && errObj?.['status'] === 400 && 'body' in err) ||
      errObj?.['type'] === 'entity.parse.failed';

    if (isMalformedJson) {
      res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Malformed JSON payload',
          requestId,
        },
      });
      return;
    }

    // 3. Body-parser payload too large (exceeding 64 KiB)
    const isPayloadTooLarge =
      errObj?.['type'] === 'entity.too.large' || errObj?.['status'] === 413;

    if (isPayloadTooLarge) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Payload exceeds 64 KiB limit',
          requestId,
        },
      });
      return;
    }

    // 4. Unexpected server exception (500)
    // Log sanitized error details internally, never exposing them in the client response
    if (logger) {
      logger.error({ err, requestId }, 'Internal server error');
    } else if (req.log) {
      req.log.error({ err, requestId }, 'Internal server error');
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId,
      },
    });
  };
}

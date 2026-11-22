import pino from 'pino';
import { pinoHttp } from 'pino-http';
import type { RequestHandler, Request, Response } from 'express';
import { getRequestId } from './request-id.js';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.body',
  'body',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'mongodbUri',
  '*.mongodbUri',
  'uri',
  '*.uri',
];

/**
 * Creates a structured Pino logger instance with strict redaction of sensitive credentials.
 */
export function createLogger(options?: pino.LoggerOptions): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    ...options,
  });
}

/**
 * Creates Pino HTTP request logging middleware.
 */
export function createHttpLogger(logger: pino.Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      return getRequestId(res as Response, req as Request);
    },
    customLogLevel: (_req, res, err) => {
      if (res.statusCode >= 500 || err) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
  });
}

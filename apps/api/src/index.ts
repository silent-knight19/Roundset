import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  ApiErrorResponseSchema,
  PlanCodeSchema,
  InterviewStatusSchema,
} from '@roundset/contracts';

export const API_SERVICE_NAME = '@roundset/api';
export const API_VERSION = '0.1.0';

export { createApp, type CreateAppOptions } from './app.js';
export {
  startServer,
  isDirectEntry,
  type StartServerOptions,
  type RunningServer,
} from './server.js';
export { loadEnv, type AppConfig } from './config/env.js';
export { MockReadinessProvider, type ReadinessProvider } from './core/readiness.js';
export { createLogger } from './core/logging.js';

export {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  ApiErrorResponseSchema,
  PlanCodeSchema,
  InterviewStatusSchema,
};

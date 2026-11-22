import { describe, it, expect } from 'vitest';
import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  ApiErrorResponseSchema,
} from '../src/index.js';

describe('Shared Contracts Smoke Tests', () => {
  // Test 1: Valid liveness response passes
  it('validates a valid liveness response', () => {
    const validLiveness = {
      data: {
        status: 'ok' as const,
        version: '0.1.0',
      },
      meta: {
        requestId: 'req_example',
      },
    };

    const result = LivenessResponseSchema.safeParse(validLiveness);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.status).toBe('ok');
      expect(result.data.data.version).toBe('0.1.0');
      expect(result.data.meta.requestId).toBe('req_example');
    }
  });

  // Test 2: Valid readiness response passes
  it('validates a valid readiness response', () => {
    const validReadiness = {
      data: {
        ready: true,
      },
      meta: {
        requestId: 'req_example',
      },
    };

    const result = ReadinessResponseSchema.safeParse(validReadiness);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.ready).toBe(true);
      expect(result.data.meta.requestId).toBe('req_example');
    }
  });

  // Test 3: Valid standardized API error passes
  it('validates a valid standardized API error', () => {
    const validError = {
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        requestId: 'req_example',
        details: {
          resource: 'interview',
          identifier: 'int_123',
        },
      },
    };

    const result = ApiErrorResponseSchema.safeParse(validError);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.code).toBe('NOT_FOUND');
      expect(result.data.error.message).toBe('Not found');
      expect(result.data.error.requestId).toBe('req_example');
      expect(result.data.error.details).toBeDefined();
    }
  });

  // Test 4: Missing request ID fails
  it('fails when requestId is missing from metadata or error', () => {
    const missingRequestIdLiveness = {
      data: {
        status: 'ok',
        version: '0.1.0',
      },
      meta: {},
    };

    const missingRequestIdError = {
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid input',
      },
    };

    const livenessResult = LivenessResponseSchema.safeParse(missingRequestIdLiveness);
    expect(livenessResult.success).toBe(false);

    const errorResult = ApiErrorResponseSchema.safeParse(missingRequestIdError);
    expect(errorResult.success).toBe(false);
  });

  // Test 5: Invalid readiness type fails
  it('fails when readiness ready field is not a boolean', () => {
    const invalidReadinessType = {
      data: {
        ready: 'yes', // should be boolean, not string
      },
      meta: {
        requestId: 'req_example',
      },
    };

    const result = ReadinessResponseSchema.safeParse(invalidReadinessType);
    expect(result.success).toBe(false);
  });

  // Test 6: Malformed liveness status fails
  it('fails when liveness status is malformed or not literal ok', () => {
    const malformedLiveness = {
      data: {
        status: 'healthy', // must be exactly 'ok'
        version: '0.1.0',
      },
      meta: {
        requestId: 'req_example',
      },
    };

    const result = LivenessResponseSchema.safeParse(malformedLiveness);
    expect(result.success).toBe(false);
  });
});

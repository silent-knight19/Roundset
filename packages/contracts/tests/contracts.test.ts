import { describe, it, expect } from 'vitest';
import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  ApiErrorResponseSchema,
  PlanCodeSchema,
  InterviewStatusSchema,
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

  // Targeted compatibility regression tests for Zod 4 migration
  it('validates API error when optional details field is omitted', () => {
    const errorWithoutDetails = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal error occurred',
        requestId: 'req_no_details_123',
      },
    };

    const result = ApiErrorResponseSchema.safeParse(errorWithoutDetails);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.details).toBeUndefined();
    }
  });

  it('rejects empty string requestId under strict validation', () => {
    const emptyRequestIdPayload = {
      data: {
        status: 'ok' as const,
        version: '0.1.0',
      },
      meta: {
        requestId: '',
      },
    };

    const result = LivenessResponseSchema.safeParse(emptyRequestIdPayload);
    expect(result.success).toBe(false);
  });

  it('validates record details structure in API error', () => {
    const errorWithNestedDetails = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid payload submitted',
        requestId: 'req_val_456',
        details: {
          field: 'email',
          issues: ['format', 'domain'],
          attempt: 1,
        },
      },
    };

    const result = ApiErrorResponseSchema.safeParse(errorWithNestedDetails);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.details).toEqual({
        field: 'email',
        issues: ['format', 'domain'],
        attempt: 1,
      });
    }
  });

  // Future-domain enum schema tests
  it('validates all approved PlanCode enum values and rejects unknown codes', () => {
    const validPlans = ['FREE', 'PAID_250', 'PAID_500', 'PAID_1000', 'VIP'];
    for (const plan of validPlans) {
      expect(PlanCodeSchema.safeParse(plan).success).toBe(true);
    }
    expect(PlanCodeSchema.safeParse('ENTERPRISE').success).toBe(false);
    expect(PlanCodeSchema.safeParse('').success).toBe(false);
  });

  it('validates all approved InterviewStatus enum values and rejects unknown statuses', () => {
    const validStatuses = [
      'DRAFT',
      'PREFLIGHT',
      'READY',
      'ACTIVE',
      'RECOVERING',
      'COMPLETED',
      'TERMINATED_INTEGRITY',
      'ABORTED_PREFLIGHT',
      'ABORTED_SYSTEM',
      'EXPIRED',
    ];
    for (const status of validStatuses) {
      expect(InterviewStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(InterviewStatusSchema.safeParse('PENDING').success).toBe(false);
    expect(InterviewStatusSchema.safeParse('').success).toBe(false);
  });
});

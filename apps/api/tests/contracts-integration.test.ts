import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockReadinessProvider } from '../src/core/readiness.js';
import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  ApiErrorResponseSchema,
  PlanCodeSchema,
  InterviewStatusSchema,
} from '@roundset/contracts';

describe('Shared Contracts Integration (P1-T08)', () => {
  it('P1-T08: Shared contracts successfully validate live and ready API responses', async () => {
    const readinessProvider = new MockReadinessProvider(true);
    const app = createApp({ readinessProvider });

    const liveRes = await request(app).get('/api/v1/health/live');
    const liveValidation = LivenessResponseSchema.safeParse(liveRes.body);
    expect(liveValidation.success).toBe(true);

    const readyRes = await request(app).get('/api/v1/health/ready');
    const readyValidation = ReadinessResponseSchema.safeParse(readyRes.body);
    expect(readyValidation.success).toBe(true);
  });

  it('P1-T08: Shared contracts reject malformed response fixtures', () => {
    // Malformed liveness: wrong status value
    const malformedLive = {
      data: { status: 'UP', version: '0.1.0' },
      meta: { requestId: 'req_123' },
    };
    expect(LivenessResponseSchema.safeParse(malformedLive).success).toBe(false);

    // Malformed readiness: missing ready boolean
    const malformedReady = {
      data: {},
      meta: { requestId: 'req_123' },
    };
    expect(ReadinessResponseSchema.safeParse(malformedReady).success).toBe(false);

    // Malformed error: missing error code
    const malformedError = {
      error: {
        message: 'Something went wrong',
        requestId: 'req_123',
      },
    };
    expect(ApiErrorResponseSchema.safeParse(malformedError).success).toBe(false);
  });

  it('P1-T08: Future domain schemas validate approved enums and reject invalid values', () => {
    // PlanCode
    expect(PlanCodeSchema.safeParse('FREE').success).toBe(true);
    expect(PlanCodeSchema.safeParse('PAID_250').success).toBe(true);
    expect(PlanCodeSchema.safeParse('PAID_500').success).toBe(true);
    expect(PlanCodeSchema.safeParse('PAID_1000').success).toBe(true);
    expect(PlanCodeSchema.safeParse('VIP').success).toBe(true);
    expect(PlanCodeSchema.safeParse('PRO').success).toBe(false);

    // InterviewStatus
    expect(InterviewStatusSchema.safeParse('DRAFT').success).toBe(true);
    expect(InterviewStatusSchema.safeParse('ACTIVE').success).toBe(true);
    expect(InterviewStatusSchema.safeParse('TERMINATED_INTEGRITY').success).toBe(true);
    expect(InterviewStatusSchema.safeParse('COMPLETED').success).toBe(true);
    expect(InterviewStatusSchema.safeParse('EXPIRED').success).toBe(true);
    expect(InterviewStatusSchema.safeParse('UNKNOWN_STATUS').success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockReadinessProvider } from '../src/core/readiness.js';
import { LivenessResponseSchema, ReadinessResponseSchema } from '@roundset/contracts';

describe('Health Endpoints (P1-T01, P1-T02)', () => {
  it('P1-T01: Live returns 200 while database readiness is false', async () => {
    const unreadyProvider = new MockReadinessProvider(false);
    const app = createApp({ readinessProvider: unreadyProvider });

    const response = await request(app).get('/api/v1/health/live');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();

    const parseResult = LivenessResponseSchema.safeParse(response.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.data.status).toBe('ok');
      expect(parseResult.data.data.version).toBe('0.1.0');
      expect(parseResult.data.meta.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('P1-T02: Ready returns 503 when database is unavailable', async () => {
    const unreadyProvider = new MockReadinessProvider(false);
    const app = createApp({ readinessProvider: unreadyProvider });

    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(503);
    expect(response.headers['x-request-id']).toBeDefined();

    const parseResult = ReadinessResponseSchema.safeParse(response.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.data.ready).toBe(false);
      expect(parseResult.data.meta.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('Ready returns 200 when database dependencies are ready', async () => {
    const readyProvider = new MockReadinessProvider(true);
    const app = createApp({ readinessProvider: readyProvider });

    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();

    const parseResult = ReadinessResponseSchema.safeParse(response.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.data.ready).toBe(true);
      expect(parseResult.data.meta.requestId).toBe(response.headers['x-request-id']);
    }
  });
});

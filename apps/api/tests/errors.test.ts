import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { createApp } from '../src/app.js';
import { ApiErrorResponseSchema } from '@roundset/contracts';

describe('Error Handling (P1-T04, P1-T05, P1-T06)', () => {
  it('P1-T04: Unknown route returns standardized 404 NOT_FOUND', async () => {
    const app = createApp();

    const res = await request(app).get('/api/v1/non-existent-route');

    expect(res.status).toBe(404);
    const parseResult = ApiErrorResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.error.code).toBe('NOT_FOUND');
      expect(parseResult.data.error.message).toBe('Not found');
      expect(parseResult.data.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('P1-T05: Malformed JSON payload returns 400 INVALID_INPUT', async () => {
    const extraRouter = Router();
    extraRouter.post('/echo', (req, res) => {
      res.json({ received: req.body });
    });

    const app = createApp({ extraRouter });

    const res = await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"badJson": true,'); // deliberate invalid JSON

    expect(res.status).toBe(400);
    const parseResult = ApiErrorResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.error.code).toBe('INVALID_INPUT');
      expect(parseResult.data.error.message).toBe('Malformed JSON payload');
      expect(parseResult.data.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('P1-T05: JSON body exceeding 64 KiB returns 413 PAYLOAD_TOO_LARGE', async () => {
    const extraRouter = Router();
    extraRouter.post('/echo', (req, res) => {
      res.json({ received: req.body });
    });

    const app = createApp({ extraRouter });

    // Generate a payload exceeding 64 KiB (65,536 bytes)
    const largeString = 'x'.repeat(66 * 1024);
    const oversizedPayload = JSON.stringify({ data: largeString });

    const res = await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send(oversizedPayload);

    expect(res.status).toBe(413);
    const parseResult = ApiErrorResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(parseResult.data.error.message).toBe('Payload exceeds 64 KiB limit');
      expect(parseResult.data.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('P1-T06: Injected handler exception returns sanitized 500 INTERNAL_ERROR', async () => {
    const extraRouter = Router();
    extraRouter.get('/simulated-crash', () => {
      throw new Error(
        'CRITICAL: MongoDB connection password=secret123 failed at /etc/secrets/mongo.key'
      );
    });

    const app = createApp({ extraRouter });

    const res = await request(app).get('/api/v1/simulated-crash');

    expect(res.status).toBe(500);
    const parseResult = ApiErrorResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.error.code).toBe('INTERNAL_ERROR');
      expect(parseResult.data.error.message).toBe('Internal server error');
      expect(parseResult.data.error.requestId).toBe(res.headers['x-request-id']);
    }

    // Crucial security check: Ensure raw error message and internal stack are not exposed
    const rawBodyString = JSON.stringify(res.body);
    expect(rawBodyString).not.toContain('password');
    expect(rawBodyString).not.toContain('secret123');
    expect(rawBodyString).not.toContain('/etc/secrets/mongo.key');
    expect(rawBodyString).not.toContain('CRITICAL');
    expect(rawBodyString).not.toContain('stack');
  });
});

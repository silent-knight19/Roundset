import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { reportAuthFailure, withAuthDiagnostics } from '../src/modules/auth/diagnostics.js';
import { MockEmailSender } from '../src/modules/auth/email/mock-email.sender.js';

describe('Authentication diagnostics and mock retention', () => {
  it('isolates concurrent request IDs and logs only fixed codes', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    await Promise.all([
      withAuthDiagnostics('request-a', logger, async () => {
        await Promise.resolve();
        reportAuthFailure('RECOVERY_WORK_FAILED');
      }),
      withAuthDiagnostics('request-b', logger, async () => reportAuthFailure('REGISTRATION_DELIVERY_FAILED')),
    ]);
    expect(warn.mock.calls).toEqual(expect.arrayContaining([
      [{ category: 'AUTH_OPERATION_FAILURE', requestId: 'request-a', reason: 'RECOVERY_WORK_FAILED' }, 'Authentication operation failed'],
      [{ category: 'AUTH_OPERATION_FAILURE', requestId: 'request-b', reason: 'REGISTRATION_DELIVERY_FAILED' }, 'Authentication operation failed'],
    ]));
    expect(warn).toHaveBeenCalledTimes(2);
    reportAuthFailure('RESEND_WORK_FAILED');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not expose failures from a broken diagnostic sink', async () => {
    const logger = { warn: () => { throw new Error('sink unavailable'); } } as unknown as Logger;
    await expect(withAuthDiagnostics('request', logger, async () => reportAuthFailure('RESEND_WORK_FAILED'))).resolves.toBeUndefined();
  });

  it('retains no more than 100 recent mock records and never captures OTP by default', async () => {
    const sender = new MockEmailSender({ nodeEnv: 'test' });
    for (let i = 0; i < 125; i++) await sender.sendOtpEmail({
      purpose: 'REGISTER_VERIFY', toEmail: 'synthetic@example.test', otpCode: '123456',
      correlationId: String(i), generation: 1,
    });
    expect(sender.sentRecords).toHaveLength(100);
    expect(sender.sentRecords[0]?.correlationId).toBe('25');
    expect(sender.getTestOtp('124')).toBeUndefined();
    expect(JSON.stringify(sender.sentRecords)).not.toContain('synthetic@example.test');
  });
});

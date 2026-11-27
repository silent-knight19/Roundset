import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { BudgetedEmailSender } from '../src/modules/auth/email/budgeted-email.sender.js';
import type { EmailSender, EmailSendRequest } from '../src/modules/auth/email/types.js';
import type { IEmailSendBudget } from '../src/modules/identity/models/email-send-budget.model.js';

function fixture() {
  const execute = vi.fn().mockResolvedValue({ generalUsed: 1, recoveryUsed: 1 });
  const findOneAndUpdate = vi.fn().mockReturnValue({ exec: execute });
  const exists = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ _id: 'day' }) });
  const create = vi.fn().mockResolvedValue({});
  const sendOtpEmail = vi.fn<EmailSender['sendOtpEmail']>().mockResolvedValue({ accepted: true, provider: 'mock' });
  const sender = new BudgetedEmailSender({ findOneAndUpdate, exists, create } as unknown as Model<IEmailSendBudget>,
    { providerName: 'mock', sendOtpEmail }, () => new Date('2026-11-27T12:00:00Z'));
  return { sender, execute, findOneAndUpdate, exists, create, sendOtpEmail };
}
function request(purpose: EmailSendRequest['purpose']): EmailSendRequest {
  return { purpose, toEmail: 'candidate@example.test', otpCode: '123456', correlationId: 'synthetic', generation: 1 };
}
describe('P2-AUTH-03b durable email budget', () => {
  it.each([['REGISTER_VERIFY', 'generalUsed', 180], ['LINK_PASSWORD', 'generalUsed', 180], ['RESET_PASSWORD', 'recoveryUsed', 60]] as const)('reserves %s before the provider call', async (purpose, key, cap) => {
    const f = fixture();
    expect(await f.sender.sendOtpEmail(request(purpose))).toMatchObject({ accepted: true });
    expect(f.findOneAndUpdate).toHaveBeenCalledWith({ dateKey: '2026-11-27', [key]: { $lt: cap } }, { $inc: { [key]: 1 } }, { new: true });
    expect(f.execute.mock.invocationCallOrder[0]).toBeLessThan(f.sendOtpEmail.mock.invocationCallOrder[0]!);
  });
  it('refuses sends when the day exists but no reservation is available', async () => {
    const f = fixture();
    f.execute.mockResolvedValue(null);
    expect(await f.sender.sendOtpEmail(request('RESET_PASSWORD'))).toMatchObject({ accepted: false });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.sendOtpEmail).not.toHaveBeenCalled();
  });
  it('retries an increment when a concurrent caller created the day', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce(null);
    expect(await f.sender.sendOtpEmail(request('RESET_PASSWORD'))).toMatchObject({ accepted: true });
    expect(f.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.sendOtpEmail).toHaveBeenCalledOnce();
  });
  it('atomically creates the first recovery reservation of a new day', async () => {
    const f = fixture();
    f.execute.mockResolvedValue(null);
    f.exists.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    expect(await f.sender.sendOtpEmail(request('RESET_PASSWORD'))).toMatchObject({ accepted: true });
    expect(f.create).toHaveBeenCalledWith({ dateKey: '2026-11-27', generalUsed: 0, recoveryUsed: 1 });
  });
  it('does not refund or retry a failed or uncertain send', async () => {
    const f = fixture();
    f.sendOtpEmail.mockRejectedValue(new Error('synthetic provider failure'));
    expect(await f.sender.sendOtpEmail(request('REGISTER_VERIFY'))).toMatchObject({ accepted: false });
    expect(f.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(f.sendOtpEmail).toHaveBeenCalledTimes(1);
  });
});

import type { Model } from 'mongoose';
import type { IEmailSendBudget } from '../../identity/models/email-send-budget.model.js';
import type { EmailSendOutcome, EmailSendRequest, EmailSender } from './types.js';

/**
 * Durable UTC-day cap for both registration and recovery. Reservation is spent
 * before the call, including failed or uncertain sends. A provider whose reset
 * boundary has not been independently verified must not be enabled in production.
 */
export class BudgetedEmailSender implements EmailSender {
  readonly providerName: EmailSender['providerName'];

  constructor(
    private readonly model: Model<IEmailSendBudget>,
    private readonly sender: EmailSender,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.providerName = sender.providerName;
  }

  async sendOtpEmail(input: EmailSendRequest): Promise<EmailSendOutcome> {
    const failure: EmailSendOutcome = {
      accepted: false, provider: this.providerName, failureCode: 'EMAIL_BUDGET_UNAVAILABLE',
    };
    const recovery = input.purpose === 'RESET_PASSWORD';
    const key = recovery ? 'recoveryUsed' : 'generalUsed';
    const cap = recovery ? 60 : 180;
    const dateKey = this.now().toISOString().slice(0, 10);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reserved = await this.model.findOneAndUpdate(
          { dateKey, [key]: { $lt: cap } },
          { $inc: { [key]: 1 } }, { new: true },
        ).exec();
        if (reserved) return await this.sender.sendOtpEmail(input);
        if (await this.model.exists({ dateKey }).exec()) continue;
        try {
          await this.model.create({
            dateKey, generalUsed: recovery ? 0 : 1, recoveryUsed: recovery ? 1 : 0,
          });
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) continue;
          return failure;
        }
        return await this.sender.sendOtpEmail(input);
      }
    } catch {
      // Never retry an uncertain reservation or refund a failed send.
    }
    return failure;
  }
}

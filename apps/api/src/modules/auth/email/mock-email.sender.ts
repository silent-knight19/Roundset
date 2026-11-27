import { ForbiddenError } from '../../../core/errors.js';
import type { EmailSendOutcome, EmailSendRequest, EmailSender } from './types.js';

export interface RecordedMockEmail {
  purpose: EmailSendRequest['purpose'];
  correlationId: string;
  generation: number;
  accepted: boolean;
  sentAt: Date;
}

export interface MockEmailSenderOptions {
  nodeEnv?: string;
  shouldAccept?: boolean;
  /** Explicit opt-in for capturing OTPs in automated tests (bounded FIFO). */
  enableTestOtpCapture?: boolean;
  maxCapturedOtps?: number;
}

/**
 * Development and test-only EmailSender.
 * Strictly refuses instantiation or execution in production.
 * Never logs or retains raw email addresses, passwords, or nonces.
 */
export class MockEmailSender implements EmailSender {
  readonly providerName = 'mock' as const;
  private readonly nodeEnv: string;
  private shouldAccept: boolean;
  private readonly enableTestOtpCapture: boolean;
  private readonly maxCapturedOtps: number;
  public readonly sentRecords: RecordedMockEmail[] = [];
  private readonly testOtpByCorrelation = new Map<string, string>();

  constructor(options: MockEmailSenderOptions = {}) {
    this.nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
    if (this.nodeEnv === 'production') {
      throw new ForbiddenError('MockEmailSender is forbidden in production');
    }
    this.shouldAccept = options.shouldAccept ?? true;
    this.enableTestOtpCapture = options.enableTestOtpCapture ?? false;
    this.maxCapturedOtps = options.maxCapturedOtps ?? 100;
  }

  setShouldAccept(accept: boolean): void {
    this.shouldAccept = accept;
  }

  getTestOtp(correlationId: string): string | undefined {
    if (!this.enableTestOtpCapture) {
      return undefined;
    }
    return this.testOtpByCorrelation.get(correlationId);
  }

  async sendOtpEmail(request: EmailSendRequest): Promise<EmailSendOutcome> {
    if (this.nodeEnv === 'production' || process.env.NODE_ENV === 'production') {
      throw new ForbiddenError('MockEmailSender is forbidden in production');
    }

    const accepted = this.shouldAccept;
    // Retain only bounded recent diagnostics; never keep an unbounded history.
    if (this.sentRecords.length >= 100) this.sentRecords.shift();
    this.sentRecords.push({
      purpose: request.purpose,
      correlationId: request.correlationId,
      generation: request.generation,
      accepted,
      sentAt: new Date(),
    });

    if (accepted) {
      if (this.enableTestOtpCapture) {
        if (this.testOtpByCorrelation.size >= this.maxCapturedOtps) {
          const oldestKey = this.testOtpByCorrelation.keys().next().value;
          if (oldestKey !== undefined) {
            this.testOtpByCorrelation.delete(oldestKey);
          }
        }
        this.testOtpByCorrelation.set(request.correlationId, request.otpCode);
      }
      return {
        accepted: true,
        provider: 'mock',
        messageId: `mock_${request.correlationId}_${request.generation}`,
      };
    }

    return {
      accepted: false,
      provider: 'mock',
      failureCode: 'MOCK_DELIVERY_REJECTED',
    };
  }
}

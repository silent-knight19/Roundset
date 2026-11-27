export type EmailPurpose = 'REGISTER_VERIFY' | 'RESET_PASSWORD' | 'LINK_PASSWORD';

export interface EmailSendRequest {
  purpose: EmailPurpose;
  toEmail: string;
  otpCode: string;
  correlationId: string;
  generation: number;
}

export interface EmailSendOutcome {
  accepted: boolean;
  provider: 'mock' | 'brevo';
  messageId?: string;
  failureCode?: string;
}

export interface EmailSender {
  readonly providerName: 'mock' | 'brevo';
  sendOtpEmail(request: EmailSendRequest): Promise<EmailSendOutcome>;
}

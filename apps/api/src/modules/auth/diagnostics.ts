import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';

export type AuthFailureCode = 'REGISTRATION_WORK_FAILED' | 'RESEND_WORK_FAILED' |
  'REGISTRATION_DELIVERY_FAILED' | 'REGISTRATION_DELIVERY_RECORD_FAILED' |
  'RECOVERY_WORK_FAILED' | 'RECOVERY_DELIVERY_FAILED' | 'RECOVERY_DELIVERY_RECORD_FAILED';

const scope = new AsyncLocalStorage<{ requestId: string; logger?: Logger }>();

export function withAuthDiagnostics<T>(requestId: string, logger: Logger | undefined, work: () => Promise<T>): Promise<T> {
  return scope.run({ requestId, logger }, work);
}

/** Never accept error objects, recipient identifiers or arbitrary metadata. */
export function reportAuthFailure(reason: AuthFailureCode): void {
  const context = scope.getStore();
  try {
    context?.logger?.warn({ category: 'AUTH_OPERATION_FAILURE', requestId: context.requestId, reason },
      'Authentication operation failed');
  } catch {
    // Diagnostics must not change the public status or interrupt a transaction.
  }
}

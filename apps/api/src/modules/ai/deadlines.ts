import {
  DeadlineComputationResult,
  PostStartDeadlineInput,
  PreStartDeadlineInput,
  SanitizedAiError,
} from './contracts.js';

function parseValidTimestampMs(
  value: Date | string | number | undefined,
  fieldName: string,
): number {
  if (value === undefined || value === null) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      `Missing required deadline field: ${fieldName}`,
    );
  }
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);

  if (!Number.isFinite(ms)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      `Invalid deadline timestamp for field: ${fieldName}`,
    );
  }
  return ms;
}

function validateClockParams(
  nowMs: number,
  safetyMarginMs: number,
  minViableCallMs: number,
): void {
  if (!Number.isFinite(nowMs) || !Number.isFinite(safetyMarginMs) || !Number.isFinite(minViableCallMs)) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Invalid numeric clock or margin parameter',
    );
  }
  if (safetyMarginMs < 0 || minViableCallMs < 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'Safety margin and minimum viable call threshold must be non-negative',
    );
  }
}

/**
 * Computes PRE_START cutoff from READY, reservation, lease, and request deadlines.
 * Never accesses startedAt or effectiveDeadlineAt.
 */
export function computePreStartCutoff(
  input: PreStartDeadlineInput,
  nowMs: number,
  safetyMarginMs = 0,
  minViableCallMs = 1,
): DeadlineComputationResult {
  validateClockParams(nowMs, safetyMarginMs, minViableCallMs);

  const readyMs = parseValidTimestampMs(input.readyExpiresAt, 'readyExpiresAt');
  const reservationMs = parseValidTimestampMs(input.reservationExpiresAt, 'reservationExpiresAt');
  const leaseMs = parseValidTimestampMs(input.controllerLeaseUntil, 'controllerLeaseUntil');
  const requestMs = parseValidTimestampMs(input.requestDeadline, 'requestDeadline');

  const cutoffAtMs = Math.min(readyMs, reservationMs, leaseMs, requestMs);
  const remainingMs = Math.max(0, cutoffAtMs - nowMs - safetyMarginMs);

  if (remainingMs < minViableCallMs) {
    throw new SanitizedAiError(
      'AI_TIMEOUT',
      'Pre-start deadline window exhausted or below minimum viable call threshold',
    );
  }

  return { cutoffAtMs, remainingMs };
}

/**
 * Computes POST_START cutoff from lease, effectiveDeadlineAt, requestDeadline,
 * and optional stricter hard-expiry or policy cutoffs.
 */
export function computePostStartCutoff(
  input: PostStartDeadlineInput,
  nowMs: number,
  safetyMarginMs = 0,
  minViableCallMs = 1,
): DeadlineComputationResult {
  validateClockParams(nowMs, safetyMarginMs, minViableCallMs);

  const leaseMs = parseValidTimestampMs(input.controllerLeaseUntil, 'controllerLeaseUntil');
  const effectiveMs = parseValidTimestampMs(input.effectiveDeadlineAt, 'effectiveDeadlineAt');
  const requestMs = parseValidTimestampMs(input.requestDeadline, 'requestDeadline');

  let cutoffAtMs = Math.min(leaseMs, effectiveMs, requestMs);

  if (input.hardExpiryAt !== undefined) {
    cutoffAtMs = Math.min(
      cutoffAtMs,
      parseValidTimestampMs(input.hardExpiryAt, 'hardExpiryAt'),
    );
  }
  if (input.policyCutoffAt !== undefined) {
    cutoffAtMs = Math.min(
      cutoffAtMs,
      parseValidTimestampMs(input.policyCutoffAt, 'policyCutoffAt'),
    );
  }

  const remainingMs = Math.max(0, cutoffAtMs - nowMs - safetyMarginMs);

  if (remainingMs < minViableCallMs) {
    throw new SanitizedAiError(
      'AI_TIMEOUT',
      'Post-start deadline window exhausted or below minimum viable call threshold',
    );
  }

  return { cutoffAtMs, remainingMs };
}

/**
 * Binds request and response consumption to min(providerTimeoutMs, remainingMs).
 */
export function computeEffectiveProviderTimeoutMs(
  providerTimeoutMs: number,
  remainingMs: number,
): number {
  if (!Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 0) {
    throw new SanitizedAiError(
      'AI_CONFIGURATION_INVALID',
      'providerTimeoutMs must be a positive finite number',
    );
  }
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new SanitizedAiError('AI_TIMEOUT', 'No remaining time budget');
  }
  return Math.min(providerTimeoutMs, remainingMs);
}

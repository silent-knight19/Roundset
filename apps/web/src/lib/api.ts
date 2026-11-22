import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type LivenessData,
  type ReadinessData,
  type ResponseMeta,
} from '@roundset/contracts';

export type LivenessResult =
  | { kind: 'online'; data: LivenessData; meta: ResponseMeta }
  | { kind: 'unavailable'; status: number; error: string }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export type ReadinessResult =
  | { kind: 'ready'; data: ReadinessData; meta: ResponseMeta }
  | { kind: 'not_ready'; data: ReadinessData; meta: ResponseMeta }
  | { kind: 'unavailable'; status: number; error: string }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export interface HealthCheckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AuthMetaData {
  activePolicyId: string;
  activeConsentVersion: string;
  registrationMode: 'PUBLIC' | 'INVITE_ONLY';
}

export type AuthMetaResult =
  | { kind: 'success'; data: AuthMetaData; meta: { requestId: string } }
  | { kind: 'unavailable'; status: number; error: string }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export const DEFAULT_TIMEOUT_MS = 5000;

interface FetchDeadlineResult {
  kind: 'success' | 'json_error' | 'offline' | 'timeout' | 'aborted';
  status?: number;
  json?: unknown;
  error?: string;
}

/**
 * Executes a GET request with an end-to-end deadline covering both
 * header retrieval and complete body consumption.
 */
async function fetchJsonWithDeadline(
  url: string,
  options?: HealthCheckOptions,
): Promise<FetchDeadlineResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('REQUEST_TIMEOUT'));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(options?.signal?.reason);
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { kind: 'aborted' };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (parseErr: unknown) {
      // If abort or timeout occurred while reading/parsing the body, propagate to outer catch
      if (controller.signal.aborted) {
        throw parseErr;
      }
      return {
        kind: 'json_error',
        status: response.status,
        error: 'Failed to parse JSON response body',
      };
    }

    return {
      kind: 'success',
      status: response.status,
      json: rawJson,
    };
  } catch (err: unknown) {
    if (timedOut) {
      return {
        kind: 'timeout',
        error: `Request timed out after ${timeoutMs}ms`,
      };
    }
    if (options?.signal?.aborted) {
      return { kind: 'aborted' };
    }
    const message =
      err instanceof Error ? err.message : 'Network error or backend unreachable';
    return {
      kind: 'offline',
      error: message,
    };
  } finally {
    clearTimeout(timer);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function fetchLiveness(
  options?: HealthCheckOptions,
): Promise<LivenessResult> {
  const result = await fetchJsonWithDeadline('/api/v1/health/live', options);

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout') {
    return { kind: 'timeout', error: result.error ?? 'Request timed out' };
  }
  if (result.kind === 'offline') {
    return {
      kind: 'offline',
      error: result.error ?? 'Backend offline or unreachable',
    };
  }

  const status = result.status ?? 0;

  // Controlled unavailable state for non-200 responses (e.g. 500, 502, 504, 404)
  if (status !== 200) {
    return {
      kind: 'unavailable',
      status,
      error: `Liveness endpoint returned HTTP ${status}`,
    };
  }

  if (result.kind === 'json_error') {
    return {
      kind: 'invalid',
      error: 'Malformed JSON response from liveness endpoint',
    };
  }

  const parsed = LivenessResponseSchema.safeParse(result.json);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      error: 'Invalid API response schema for liveness',
    };
  }

  return {
    kind: 'online',
    data: parsed.data.data,
    meta: parsed.data.meta,
  };
}

export async function fetchReadiness(
  options?: HealthCheckOptions,
): Promise<ReadinessResult> {
  const result = await fetchJsonWithDeadline('/api/v1/health/ready', options);

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout') {
    return { kind: 'timeout', error: result.error ?? 'Request timed out' };
  }
  if (result.kind === 'offline') {
    return {
      kind: 'offline',
      error: result.error ?? 'Backend offline or unreachable',
    };
  }

  const status = result.status ?? 0;

  // Controlled unavailable state for non-200/503 responses (e.g. 500, 502, 504, 404)
  if (status !== 200 && status !== 503) {
    return {
      kind: 'unavailable',
      status,
      error: `Readiness endpoint returned HTTP ${status}`,
    };
  }

  if (result.kind === 'json_error') {
    return {
      kind: 'invalid',
      error: 'Malformed JSON response from readiness endpoint',
    };
  }

  const parsed = ReadinessResponseSchema.safeParse(result.json);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      error: 'Invalid API response schema for readiness',
    };
  }

  const isReady = parsed.data.data.ready;

  // Strict Matrix Enforcement:
  // HTTP 200 + ready: true  -> ready
  // HTTP 503 + ready: false -> not_ready
  // HTTP 200 + ready: false -> invalid (contradictory)
  // HTTP 503 + ready: true  -> invalid (contradictory)
  if (status === 200) {
    if (isReady) {
      return {
        kind: 'ready',
        data: parsed.data.data,
        meta: parsed.data.meta,
      };
    } else {
      return {
        kind: 'invalid',
        error: 'Contradictory readiness response: HTTP 200 returned ready: false',
      };
    }
  } else {
    // status === 503
    if (!isReady) {
      return {
        kind: 'not_ready',
        data: parsed.data.data,
        meta: parsed.data.meta,
      };
    } else {
      return {
        kind: 'invalid',
        error: 'Contradictory readiness response: HTTP 503 returned ready: true',
      };
    }
  }
}

export interface CombinedHealthResult {
  liveness: LivenessResult;
  readiness: ReadinessResult;
}

export async function fetchHealthOverview(
  options?: HealthCheckOptions,
): Promise<CombinedHealthResult> {
  const [liveness, readiness] = await Promise.all([
    fetchLiveness(options),
    fetchReadiness(options),
  ]);
  return { liveness, readiness };
}

export async function fetchAuthMeta(
  options?: HealthCheckOptions,
): Promise<AuthMetaResult> {
  const result = await fetchJsonWithDeadline('/api/v1/auth/meta', options);

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout') {
    return { kind: 'timeout', error: result.error ?? 'Request timed out' };
  }
  if (result.kind === 'offline') {
    return {
      kind: 'offline',
      error: result.error ?? 'Backend offline or unreachable',
    };
  }

  const status = result.status ?? 0;
  if (status !== 200) {
    return {
      kind: 'unavailable',
      status,
      error: `Auth meta endpoint returned HTTP ${status}`,
    };
  }

  if (result.kind === 'json_error') {
    return {
      kind: 'invalid',
      error: 'Malformed JSON response from auth meta endpoint',
    };
  }

  const json = result.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      kind: 'invalid',
      error: 'Malformed JSON response envelope from auth meta endpoint',
    };
  }

  const envelope = json as Record<string, unknown>;
  const meta = envelope.meta as Record<string, unknown> | null | undefined;
  if (
    !meta ||
    typeof meta !== 'object' ||
    typeof meta.requestId !== 'string' ||
    meta.requestId.trim().length === 0
  ) {
    return {
      kind: 'invalid',
      error: 'Missing or empty requestId in auth meta response envelope',
    };
  }

  const data = envelope.data as Record<string, unknown> | null | undefined;
  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.activePolicyId !== 'string' ||
    data.activePolicyId.trim().length === 0 ||
    typeof data.activeConsentVersion !== 'string' ||
    data.activeConsentVersion.trim().length === 0 ||
    (data.registrationMode !== 'PUBLIC' && data.registrationMode !== 'INVITE_ONLY')
  ) {
    return {
      kind: 'invalid',
      error: 'Invalid API response schema for auth meta data',
    };
  }

  return {
    kind: 'success',
    data: {
      activePolicyId: data.activePolicyId.trim(),
      activeConsentVersion: data.activeConsentVersion.trim(),
      registrationMode: data.registrationMode as 'PUBLIC' | 'INVITE_ONLY',
    },
    meta: {
      requestId: meta.requestId.trim(),
    },
  };
}

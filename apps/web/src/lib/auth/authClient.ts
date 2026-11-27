import {
  ApiErrorResponseSchema,
  AuthMetaResponseSchema,
  SessionResponseSchema,
  type AuthMetaResponseData,
  type ResponseMeta,
  type SessionData,
} from '@roundset/contracts';
import { readCsrfCookie } from './cookies';

export const DEFAULT_AUTH_TIMEOUT_MS = 5000;

export interface AuthRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AuthMetaClientResult =
  | { kind: 'success'; data: AuthMetaResponseData; meta: ResponseMeta }
  | { kind: 'unavailable'; status: number; error: string }
  | { kind: 'offline'; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export type RefreshSessionResult =
  | { kind: 'authenticated'; data: SessionData; meta: ResponseMeta }
  | { kind: 'unauthenticated'; status: number; code?: string; error: string }
  | { kind: 'replay_detected'; status: number; error: string }
  | { kind: 'relogin_required'; status: number; code?: string; error: string }
  | {
      kind: 'uncertain';
      reason:
        | 'timeout'
        | 'network'
        | 'malformed'
        | 'aborted_after_dispatch'
        | 'lock_timeout';
      error: string;
    }
  | { kind: 'unavailable'; status: number; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'aborted' };

export type LogoutResult =
  | { kind: 'logged_out' }
  | { kind: 'already_logged_out'; status: number; error: string }
  | { kind: 'mismatch'; status: number; code?: string; error: string }
  | { kind: 'error'; status?: number; error: string }
  | { kind: 'aborted' };

export type LogoutAllResult =
  | { kind: 'logged_out_all' }
  | { kind: 'unauthenticated'; status: number; code?: string; error: string }
  | { kind: 'error'; status?: number; error: string }
  | { kind: 'aborted' };

interface DeadlineFetchResult {
  kind: 'response' | 'offline' | 'timeout' | 'aborted';
  afterDispatch: boolean;
  status?: number;
  json?: unknown;
  jsonParseError?: boolean;
  error?: string;
}

async function fetchAuthWithDeadline(
  url: string,
  init: RequestInit,
  options?: AuthRequestOptions,
): Promise<DeadlineFetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let dispatched = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('AUTH_REQUEST_TIMEOUT'));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(options?.signal?.reason);
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { kind: 'aborted', afterDispatch: false };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    dispatched = true;
    const response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      signal: controller.signal,
    });

    // 204 No Content has no JSON body
    if (response.status === 204) {
      return {
        kind: 'response',
        afterDispatch: true,
        status: 204,
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (parseErr: unknown) {
      if (controller.signal.aborted) {
        throw parseErr;
      }
      return {
        kind: 'response',
        afterDispatch: true,
        status: response.status,
        jsonParseError: true,
        error: 'Failed to parse JSON response body',
      };
    }

    return {
      kind: 'response',
      afterDispatch: true,
      status: response.status,
      json: rawJson,
    };
  } catch (err: unknown) {
    if (timedOut) {
      return {
        kind: 'timeout',
        afterDispatch: dispatched,
        error: `Auth request timed out after ${timeoutMs}ms`,
      };
    }
    if (options?.signal?.aborted) {
      return { kind: 'aborted', afterDispatch: dispatched };
    }
    return {
      kind: 'offline',
      afterDispatch: dispatched,
      error: err instanceof Error ? err.message : 'Network error or backend unreachable',
    };
  } finally {
    clearTimeout(timer);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function parseApiError(json: unknown): { code?: string; message?: string } {
  const parsed = ApiErrorResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {};
  }
  return {
    code: parsed.data.error.code,
    message: parsed.data.error.message,
  };
}

/**
 * Fetches public authentication metadata (`GET /api/v1/auth/meta`).
 */
export async function getAuthMeta(
  options?: AuthRequestOptions,
): Promise<AuthMetaClientResult> {
  const result = await fetchAuthWithDeadline(
    '/api/v1/auth/meta',
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    options,
  );

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout') {
    return { kind: 'timeout', error: result.error ?? 'Request timed out' };
  }
  if (result.kind === 'offline') {
    return { kind: 'offline', error: result.error ?? 'Backend offline or unreachable' };
  }

  const status = result.status ?? 0;
  if (status !== 200) {
    const apiErr = parseApiError(result.json);
    return {
      kind: 'unavailable',
      status,
      error: apiErr.message ?? `Auth meta endpoint returned HTTP ${status}`,
    };
  }

  if (result.jsonParseError) {
    return {
      kind: 'invalid',
      error: 'Malformed JSON response from auth meta endpoint',
    };
  }

  const parsed = AuthMetaResponseSchema.safeParse(result.json);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      error: 'Invalid API response schema for auth meta',
    };
  }

  return {
    kind: 'success',
    data: parsed.data.data,
    meta: parsed.data.meta,
  };
}

/**
 * Executes `POST /api/v1/auth/refresh` using the HttpOnly refresh cookie
 * managed by the browser and the current JS-readable CSRF cookie in `X-CSRF-Token`.
 *
 * Must be called inside the refresh lock so the latest CSRF cookie is read.
 */
export async function refreshSession(
  options?: AuthRequestOptions,
): Promise<RefreshSessionResult> {
  const csrfToken = readCsrfCookie();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const result = await fetchAuthWithDeadline(
    '/api/v1/auth/refresh',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    options,
  );

  if (result.kind === 'aborted') {
    if (result.afterDispatch) {
      return {
        kind: 'uncertain',
        reason: 'aborted_after_dispatch',
        error: 'Refresh request was cancelled after dispatch; session state uncertain',
      };
    }
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout') {
    return {
      kind: 'uncertain',
      reason: 'timeout',
      error: result.error ?? 'Refresh request timed out; session state uncertain',
    };
  }
  if (result.kind === 'offline') {
    return {
      kind: 'uncertain',
      reason: 'network',
      error: result.error ?? 'Network failure during refresh; session state uncertain',
    };
  }

  const status = result.status ?? 0;

  if (status === 200) {
    if (result.jsonParseError) {
      return {
        kind: 'uncertain',
        reason: 'malformed',
        error: 'Malformed JSON in refresh response; session state uncertain',
      };
    }

    const parsed = SessionResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        error: 'Invalid API response schema for session refresh',
      };
    }

    return {
      kind: 'authenticated',
      data: parsed.data.data,
      meta: parsed.data.meta,
    };
  }

  const apiErr = parseApiError(result.json);

  if (status === 401) {
    if (apiErr.code === 'SESSION_REPLAY_DETECTED') {
      return {
        kind: 'replay_detected',
        status,
        error: apiErr.message ?? 'Session replay detected; please sign in again',
      };
    }
    return {
      kind: 'unauthenticated',
      status,
      code: apiErr.code,
      error: apiErr.message ?? 'Authentication required',
    };
  }

  if (status === 403) {
    return {
      kind: 'relogin_required',
      status,
      code: apiErr.code,
      error: apiErr.message ?? 'Session verification rejected; please sign in again',
    };
  }

  return {
    kind: 'unavailable',
    status,
    error: apiErr.message ?? `Refresh endpoint returned HTTP ${status}`,
  };
}

/**
 * Executes `POST /api/v1/auth/logout` for the current session.
 * Sends `X-CSRF-Token` from the current CSRF cookie and optional `Authorization: Bearer`.
 */
export async function logoutSession(
  options: AuthRequestOptions & { accessToken?: string | null } = {},
): Promise<LogoutResult> {
  const csrfToken = readCsrfCookie();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (options.accessToken) {
    headers['Authorization'] = `Bearer ${options.accessToken}`;
  }

  const result = await fetchAuthWithDeadline(
    '/api/v1/auth/logout',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    options,
  );

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout' || result.kind === 'offline') {
    return {
      kind: 'error',
      error: result.error ?? 'Failed to reach logout endpoint',
    };
  }

  const status = result.status ?? 0;
  if (status === 204) {
    return { kind: 'logged_out' };
  }

  const apiErr = parseApiError(result.json);

  if (status === 403) {
    return {
      kind: 'mismatch',
      status,
      code: apiErr.code,
      error: apiErr.message ?? 'Logout credential and session mismatch',
    };
  }

  if (status === 401 || status === 404) {
    return {
      kind: 'already_logged_out',
      status,
      error: apiErr.message ?? 'Session already inactive',
    };
  }

  return {
    kind: 'error',
    status,
    error: apiErr.message ?? `Logout endpoint returned HTTP ${status}`,
  };
}

/**
 * Executes `POST /api/v1/auth/logout-all` using the active Bearer access token.
 */
export async function logoutAllSessions(
  options: AuthRequestOptions & { accessToken: string },
): Promise<LogoutAllResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.accessToken}`,
  };

  const result = await fetchAuthWithDeadline(
    '/api/v1/auth/logout-all',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    options,
  );

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (result.kind === 'timeout' || result.kind === 'offline') {
    return {
      kind: 'error',
      error: result.error ?? 'Failed to reach logout-all endpoint',
    };
  }

  const status = result.status ?? 0;
  if (status === 204) {
    return { kind: 'logged_out_all' };
  }

  const apiErr = parseApiError(result.json);

  if (status === 401 || status === 403) {
    return {
      kind: 'unauthenticated',
      status,
      code: apiErr.code,
      error: apiErr.message ?? 'Authentication required for logout-all',
    };
  }

  return {
    kind: 'error',
    status,
    error: apiErr.message ?? `Logout-all endpoint returned HTTP ${status}`,
  };
}

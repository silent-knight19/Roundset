import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AuthSessionDto, AuthUserDto } from '@roundset/contracts';
import type {
  AuthRequestOptions,
  LogoutAllResult,
  LogoutResult,
} from '../lib/auth/authClient';
import { SessionCoordinator } from '../lib/auth/sessionCoordinator';

export type AuthStatus =
  | 'loading'
  | 'unauthenticated'
  | 'authenticated'
  | 'relogin_required'
  | 'unavailable';

export type ReloginReason =
  | 'replay_detected'
  | 'uncertain_refresh'
  | 'session_mismatch'
  | 'forbidden'
  | 'malformed_response';

export interface AuthState {
  status: AuthStatus;
  user: AuthUserDto | null;
  session: AuthSessionDto | null;
  reloginReason: ReloginReason | null;
  error: string | null;
  crossTabSupported: boolean;
}

export interface AuthContextValue extends AuthState {
  getAccessToken: () => string | null;
  refresh: (options?: AuthRequestOptions) => Promise<void>;
  logout: (options?: AuthRequestOptions) => Promise<LogoutResult>;
  logoutAll: (options?: AuthRequestOptions) => Promise<LogoutAllResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: React.ReactNode;
  coordinator?: SessionCoordinator;
  skipInitialBootstrap?: boolean;
}

export function AuthProvider({
  children,
  coordinator: externalCoordinator,
  skipInitialBootstrap = false,
}: AuthProviderProps) {
  // Access JWT is strictly memory-only inside this ref.
  const accessTokenRef = useRef<string | null>(null);
  const mountedRef = useRef<boolean>(true);
  const coordinatorRef = useRef<SessionCoordinator | null>(null);

  if (!coordinatorRef.current) {
    coordinatorRef.current = externalCoordinator ?? new SessionCoordinator();
  }

  const [state, setState] = useState<AuthState>(() => ({
    status: skipInitialBootstrap ? 'unauthenticated' : 'loading',
    user: null,
    session: null,
    reloginReason: null,
    error: null,
    crossTabSupported: coordinatorRef.current?.crossTabSupported ?? false,
  }));

  const clearInMemorySession = useCallback(
    (
      nextStatus: Exclude<AuthStatus, 'authenticated'>,
      reloginReason: ReloginReason | null = null,
      error: string | null = null,
    ) => {
      accessTokenRef.current = null;
      if (!mountedRef.current) {
        return;
      }
      setState((prev) => ({
        ...prev,
        status: nextStatus,
        user: null,
        session: null,
        reloginReason,
        error,
      }));
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const coordinator = coordinatorRef.current;
    if (!coordinator) {
      return;
    }

    coordinator.attachCallbacks({
      onExternalLogout: () => {
        clearInMemorySession('unauthenticated', null, null);
      },
      onExternalInvalidation: (reason) => {
        clearInMemorySession(
          'relogin_required',
          reason === 'replay_detected' ? 'replay_detected' : 'forbidden',
          reason === 'replay_detected'
            ? 'Session invalidated due to replay detection. Please sign in again.'
            : 'Session requires reauthentication. Please sign in again.',
        );
      },
    });

    return () => {
      mountedRef.current = false;
      if (!externalCoordinator) {
        coordinator.dispose();
      }
    };
  }, [clearInMemorySession, externalCoordinator]);

  const applyRefreshOutcome = useCallback(
    async (options?: AuthRequestOptions): Promise<void> => {
      const coordinator = coordinatorRef.current;
      if (!coordinator) {
        return;
      }

      const { result, stale } = await coordinator.refresh(options);

      // Stale async responses (e.g., completed after logout/logout-all) must never restore a session.
      if (stale || !mountedRef.current) {
        return;
      }

      switch (result.kind) {
        case 'authenticated': {
          accessTokenRef.current = result.data.accessToken;
          setState((prev) => ({
            ...prev,
            status: 'authenticated',
            user: result.data.user,
            session: result.data.session,
            reloginReason: null,
            error: null,
          }));
          break;
        }
        case 'unauthenticated': {
          clearInMemorySession('unauthenticated', null, null);
          break;
        }
        case 'replay_detected': {
          clearInMemorySession('relogin_required', 'replay_detected', result.error);
          break;
        }
        case 'relogin_required': {
          clearInMemorySession('relogin_required', 'forbidden', result.error);
          break;
        }
        case 'uncertain': {
          clearInMemorySession('relogin_required', 'uncertain_refresh', result.error);
          break;
        }
        case 'invalid': {
          clearInMemorySession('relogin_required', 'malformed_response', result.error);
          break;
        }
        case 'unavailable': {
          clearInMemorySession('unavailable', null, result.error);
          break;
        }
        case 'aborted': {
          break;
        }
      }
    },
    [clearInMemorySession],
  );

  // Initial session restoration on mount (StrictMode-safe via single-flight coordinator)
  useEffect(() => {
    if (skipInitialBootstrap) {
      return;
    }

    void applyRefreshOutcome();
  }, [applyRefreshOutcome, skipInitialBootstrap]);

  const refresh = useCallback(
    async (options?: AuthRequestOptions): Promise<void> => {
      if (mountedRef.current) {
        setState((prev) => ({
          ...prev,
          status: 'loading',
          error: null,
        }));
      }
      await applyRefreshOutcome(options);
    },
    [applyRefreshOutcome],
  );

  const logout = useCallback(
    async (options?: AuthRequestOptions): Promise<LogoutResult> => {
      const coordinator = coordinatorRef.current;
      if (!coordinator) {
        return { kind: 'error', error: 'Session coordinator unavailable' };
      }

      const currentToken = accessTokenRef.current;
      const result = await coordinator.logout({
        ...options,
        accessToken: currentToken,
      });

      if (result.kind === 'logged_out' || result.kind === 'already_logged_out') {
        clearInMemorySession('unauthenticated', null, null);
      } else if (result.kind === 'mismatch') {
        // Backend rejected logout due to Bearer/cookie session mismatch (403);
        // server did not revoke session or clear cookies. Report honestly.
        accessTokenRef.current = null;
        if (mountedRef.current) {
          setState((prev) => ({
            ...prev,
            status: 'relogin_required',
            user: null,
            session: null,
            reloginReason: 'session_mismatch',
            error: result.error,
          }));
        }
      }

      return result;
    },
    [clearInMemorySession],
  );

  const logoutAll = useCallback(
    async (options?: AuthRequestOptions): Promise<LogoutAllResult> => {
      const coordinator = coordinatorRef.current;
      const currentToken = accessTokenRef.current;

      if (!coordinator || !currentToken) {
        clearInMemorySession('unauthenticated', null, null);
        return {
          kind: 'unauthenticated',
          status: 401,
          error: 'No active access token available for logout-all',
        };
      }

      const result = await coordinator.logoutAll({
        ...options,
        accessToken: currentToken,
      });

      if (result.kind === 'logged_out_all' || result.kind === 'unauthenticated') {
        clearInMemorySession('unauthenticated', null, null);
      } else if (result.kind === 'error' && mountedRef.current) {
        setState((prev) => ({
          ...prev,
          error: result.error,
        }));
      }

      return result;
    },
    [clearInMemorySession],
  );

  const getAccessToken = useCallback(() => accessTokenRef.current, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      getAccessToken,
      refresh,
      logout,
      logoutAll,
    }),
    [state, getAccessToken, refresh, logout, logoutAll],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

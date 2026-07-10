import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiClient, type AuthClient } from "../api/client";

interface AuthState {
  /** True only while the initial session probe (GET /notes) is in flight, so the
   *  app can avoid flashing the login form before we know a cookie is already valid. */
  loading: boolean;
  authenticated: boolean;
  /** Known once login() resolves in this session; a probe-only session (page reload
   *  with an existing cookie) has no way to recover it — there is no /whoami route. */
  username: string | null;
  /** Collab auth token for the Hocuspocus provider (Task 6); null until login(). */
  token: string | null;
}

export interface AuthContextValue extends AuthState {
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const INITIAL_STATE: AuthState = {
  loading: true,
  authenticated: false,
  username: null,
  token: null,
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  client = apiClient,
}: {
  children: ReactNode;
  client?: AuthClient;
}) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  useEffect(() => {
    client.setUnauthorizedHandler(() => {
      setState({ loading: false, authenticated: false, username: null, token: null });
    });
    return () => client.setUnauthorizedHandler(null);
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client
      .listNotes()
      .then(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, authenticated: true }));
      })
      .catch(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, authenticated: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await client.login(username, password);
      setState({ loading: false, authenticated: true, username: result.username, token: result.token });
    },
    [client],
  );

  const logout = useCallback(async () => {
    await client.logout();
    setState({ loading: false, authenticated: false, username: null, token: null });
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout }),
    [state, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

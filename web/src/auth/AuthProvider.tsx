import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, refreshSession, setAccessToken, setAuthLostHandler } from '../lib/api';
import type { AuthResponse, Business, User, UserRole } from '../lib/types';

/**
 * Who is signed in, and the four things you can do about it.
 *
 * The access token is never stored here or anywhere else durable — it lives in
 * a module variable inside `lib/api`, unreachable from React state and gone on
 * reload. What survives a reload is the httpOnly refresh cookie, which
 * JavaScript cannot read at all. On mount this component spends one round trip
 * exchanging that cookie for a fresh access token; if it fails, nobody is
 * signed in. That is the whole persistence story, and it means an XSS payload
 * has nothing durable to steal.
 */

interface AuthState {
  user: User | null;
  business: Business | null;
  /// True until the initial refresh settles. Rendering routes before this
  /// resolves would bounce a signed-in user to the login screen for a frame.
  initialising: boolean;
  signIn: (identifier: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => Promise<void>;
  /// Refetches the profile — after changing a name or role, say.
  reload: () => Promise<void>;
  can: (...roles: UserRole[]) => boolean;
}

export interface SignUpInput {
  business: {
    legalName: string;
    tradeName?: string;
    gstin: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    pincode: string;
    phone: string;
    email?: string;
  };
  owner: {
    fullName: string;
    email?: string;
    phone: string;
    password: string;
  };
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [initialising, setInitialising] = useState(true);

  // Guards against a state update after unmount in React 18 StrictMode, which
  // mounts, unmounts and remounts every effect in development.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setBusiness(null);
  }, []);

  const loadProfile = useCallback(async () => {
    const profile = await api.get<{ user: User; business: Business }>('/api/auth/me');
    setUser(profile.user);
    setBusiness(profile.business);
  }, []);

  // One refresh attempt on mount. A 401 here is the normal "not signed in"
  // case, not an error worth showing.
  useEffect(() => {
    void (async () => {
      try {
        if (await refreshSession()) await loadProfile();
      } catch {
        clear();
      } finally {
        if (mounted.current) setInitialising(false);
      }
    })();
  }, [clear, loadProfile]);

  // When a refresh fails mid-session — the token expired, or it was revoked
  // because someone signed out everywhere — drop to signed-out immediately
  // rather than letting every subsequent request fail on its own.
  useEffect(() => {
    setAuthLostHandler(() => {
      if (mounted.current) clear();
    });
    return () => setAuthLostHandler(null);
  }, [clear]);

  const adopt = useCallback((response: AuthResponse) => {
    setAccessToken(response.accessToken);
    setUser(response.user);
    setBusiness(response.business);
  }, []);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const response = await api.post<AuthResponse>(
        '/api/auth/login',
        { identifier: identifier.trim(), password },
        // A 401 here means "wrong password", not "token expired" — refreshing
        // and retrying would be wrong and would waste the refresh token.
        { skipRefresh: true },
      );
      adopt(response);
    },
    [adopt],
  );

  const signUp = useCallback(
    async (input: SignUpInput) => {
      const response = await api.post<AuthResponse>('/api/auth/register', input, {
        skipRefresh: true,
      });
      adopt(response);
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    try {
      // Revokes the session server-side and clears the cookie. If it fails —
      // offline, say — the local state is cleared regardless, because a user
      // who pressed "sign out" must end up signed out.
      await api.post('/api/auth/logout', {}, { skipRefresh: true });
    } catch {
      /* deliberately ignored */
    } finally {
      clear();
    }
  }, [clear]);

  const can = useCallback(
    (...roles: UserRole[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      business,
      initialising,
      signIn,
      signUp,
      signOut,
      reload: loadProfile,
      can,
    }),
    [user, business, initialising, signIn, signUp, signOut, loadProfile, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/// Role bundles, mirroring `src/middleware/authorize.ts` on the server.
/// These hide controls the user cannot use; the server is what enforces them.
export const CAN_MANAGE_USERS: UserRole[] = ['OWNER'];
export const CAN_EDIT_MASTERS: UserRole[] = ['OWNER', 'MANAGER'];
export const CAN_BILL: UserRole[] = ['OWNER', 'MANAGER', 'BILLING_STAFF'];
export const CAN_RECEIVE_PAYMENT: UserRole[] = ['OWNER', 'MANAGER', 'BILLING_STAFF', 'ACCOUNTANT'];
export const CAN_SEE_COST: UserRole[] = ['OWNER', 'MANAGER', 'ACCOUNTANT'];

import type { LoginResponse, User } from "@bandapp/types";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/api";
import { sessionEvents } from "@/services/session-events";
import { tokenStorage } from "@/services/token-storage";
import { appleCredential } from "./providers/apple";
import { googleIdToken } from "./providers/google";

export type AuthState =
  | { status: "restoring" }
  | { status: "guest" }
  | { status: "authenticated"; user: User };

interface AuthContextValue {
  state: AuthState;
  signInWithGoogle(): Promise<LoginResponse>;
  signInWithApple(): Promise<LoginResponse>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const usingMock = !process.env.EXPO_PUBLIC_API_URL;

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<AuthState>({ status: "restoring" });

  useEffect(() => {
    sessionEvents.setHandler(() => setState({ status: "guest" }));
    return () => sessionEvents.setHandler(null);
  }, []);

  useEffect(() => {
    // 앱 시작 시 세션 복원 (기획서 23장)
    let cancelled = false;
    (async () => {
      if (usingMock) {
        // 서버 없이도 앱이 돌게 Mock에서는 로그인된 상태로 시작
        const user = await api.auth.me();
        if (!cancelled) setState({ status: "authenticated", user });
        return;
      }
      const refreshToken = await tokenStorage.getRefreshToken();
      if (!refreshToken) {
        if (!cancelled) setState({ status: "guest" });
        return;
      }
      try {
        // access는 메모리에 없으므로 me() 호출이 401 → 자동 refresh → 재시도로 복원된다
        const user = await api.auth.me();
        if (!cancelled) setState({ status: "authenticated", user });
      } catch {
        await tokenStorage.clear();
        if (!cancelled) setState({ status: "guest" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function signInWithGoogle(): Promise<LoginResponse> {
    const idToken = await googleIdToken();
    const res = await api.auth.loginWithGoogle(idToken);
    setState({ status: "authenticated", user: res.user });
    return res;
  }

  async function signInWithApple(): Promise<LoginResponse> {
    const { idToken, displayName } = await appleCredential();
    const res = await api.auth.loginWithApple(idToken, displayName);
    setState({ status: "authenticated", user: res.user });
    return res;
  }

  async function signOut(): Promise<void> {
    await api.auth.logout(); // 서버 세션 revoke + 로컬 토큰 삭제 (기획서 17장)
    setState({ status: "guest" });
  }

  async function deleteAccount(): Promise<void> {
    await api.auth.deleteAccount();
    setState({ status: "guest" });
  }

  return (
    <AuthContext.Provider value={{ state, signInWithGoogle, signInWithApple, signOut, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}

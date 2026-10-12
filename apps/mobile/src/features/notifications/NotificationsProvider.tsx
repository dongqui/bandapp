import { ApiError } from "@bandapp/api-client";
import { useRouter } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { push } from "@/services/push";
import { useToast } from "@/ui";
import { pushTokenHandle } from "./pushTokenHandle";
import { routeFor, type PendingTarget } from "./pushTarget";
import type { PushPermission } from "./settingsView";

interface NotificationsValue {
  unreadCount: number;
  permission: PushPermission;
  refreshPermission(): Promise<void>;
  requestPermission(): Promise<PushPermission>;
  /** 배지 다시 읽기 */
  refresh(): void;
  sheetOpen: boolean;
  setSheetOpen(v: boolean): void;
  /** 알림(인박스·푸시)을 열어 목적지로 간다. 밴드가 다르면 먼저 바꾼다 (스펙 결정 4) */
  open(target: PendingTarget): Promise<void>;
}

const Ctx = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const { state } = useAuth();
  const authed = state.status === "authenticated";
  const { band, bands, loading, setCurrentBand } = useCurrentBand();
  const [unreadCount, setUnreadCount] = useState(0);
  const [permission, setPermission] = useState<PushPermission>("unavailable");
  const [sheetOpen, setSheetOpen] = useState(false);
  const pending = useRef<PendingTarget | null>(null);
  const [pendingTick, setPendingTick] = useState(0);
  const lastToken = useRef<string | null>(null);

  const refreshPermission = useCallback(async () => setPermission(await push.permission()), []);
  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission]);

  const refresh = useCallback(() => {
    const bandId = band?.id;
    if (!authed || !bandId) {
      setUnreadCount(0);
      return;
    }
    api.notifications.unreadCount(bandId).then(setUnreadCount).catch((e) => console.warn("unread count failed", e));
  }, [api, authed, band?.id]);

  // 갱신 시점: 밴드 변경·로그인, 데이터 변경 통지, 포그라운드 복귀(권한도 다시 읽음 — iOS 설정에서 돌아온 경우), 포그라운드 푸시. 주기 폴링 없음
  useEffect(() => {
    refresh();
    const offApi = api.subscribe(refresh);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        refresh();
        void refreshPermission();
      }
    });
    const offMsg = push.onForegroundMessage(refresh);
    return () => {
      offApi();
      sub.remove();
      offMsg();
    };
  }, [api, refresh, refreshPermission]);

  /** 허용 상태 + 로그인 → 토큰 등록. 토큰 갱신도 같은 경로 */
  const syncToken = useCallback(async () => {
    if (!authed) return;
    const token = await push.getToken();
    if (!token) return;
    lastToken.current = token;
    await api.notifications
      .registerPushToken({ token, platform: push.platform(), locale: push.locale() })
      .catch((e) => console.warn("push token register failed", e));
  }, [api, authed]);

  useEffect(() => {
    if (!authed || permission !== "allowed") return;
    void syncToken();
    return push.onTokenRefresh(() => void syncToken());
  }, [authed, permission, syncToken]);

  // 첫 권한 요청: 첫 밴드에 들어온 직후 한 번 (스펙 결정 10). 거부하면 다시 묻지 않는다 (pushAsked 플래그는 push.request가 남긴다)
  const askedThisRun = useRef(false);
  useEffect(() => {
    if (askedThisRun.current || !authed || loading || bands.length === 0 || permission !== "ask") return;
    askedThisRun.current = true;
    void push.request().then(setPermission);
  }, [authed, loading, bands.length, permission]);

  const requestPermission = useCallback(async () => {
    const p = await push.request();
    setPermission(p);
    return p;
  }, []);

  const open = useCallback(
    async (target: PendingTarget) => {
      setSheetOpen(false);
      // 더 이상 멤버가 아닌 밴드로는 전환하지 않는다
      if (!bands.some((b) => b.id === target.bandId)) {
        toast.show(t("notifications.gone"));
        return;
      }
      if (band?.id !== target.bandId) setCurrentBand(target.bandId);
      try {
        if (target.notificationId) await api.notifications.markRead(target.notificationId);
        // 세션 접근 가능 여부를 먼저 확인 — 쫓겨났거나 지워졌으면 403/404
        await api.sessions.get(target.sessionId);
        router.push(routeFor(target));
      } catch (err) {
        if (!(err instanceof ApiError)) console.warn("notification open failed", err);
        toast.show(t("notifications.gone"));
      }
    },
    [api, band?.id, bands, router, setCurrentBand, t, toast],
  );

  // 푸시 탭 (콜드 스타트 포함). push.ts가 콜드 스타트 알림을 앱 생애 동안 한 번만 전달하므로
  // 인증·밴드 상태와 무관하게 항상 pending에 담고, 아래 effect가 준비되면 소비한다
  useEffect(() => {
    return push.onOpened((target) => {
      pending.current = target;
      setPendingTick((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    // bands.length > 0도 요구한다: CurrentBandProvider가 로그인 직후 한 커밋 동안 빈 bands/loading=false를 노출할 수 있어
    // 그 틈에 소비하면 멤버가 아닌 것으로 오판한다. 푸시는 항상 밴드를 가리키므로 밴드가 없으면 기다리는 게 맞다
    if (!pending.current || !authed || loading || bands.length === 0) return;
    const target = pending.current;
    pending.current = null;
    void open(target);
  }, [authed, loading, bands.length, open, pendingTick]);

  /** 로그아웃·탈퇴 직전에 AuthProvider가 부른다 (pushTokenHandle) */
  useEffect(() => {
    pushTokenHandle.current = async () => {
      const token = lastToken.current;
      if (!token) return;
      lastToken.current = null;
      await api.notifications.removePushToken(token).catch(() => undefined);
    };
    return () => {
      pushTokenHandle.current = async () => undefined;
    };
  }, [api]);

  return (
    <Ctx.Provider value={{ unreadCount, permission, refreshPermission, requestPermission, refresh, sheetOpen, setSheetOpen, open }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used within NotificationsProvider");
  return v;
}

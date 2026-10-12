import { Linking, PermissionsAndroid, Platform } from "react-native";
import { getLocales } from "expo-localization";
import { secureStorage } from "@/services/secure-storage";
import type { PushPermission } from "@/features/notifications/settingsView";
import { parsePushData, type PendingTarget } from "@/features/notifications/pushTarget";

/**
 * Firebase를 만지는 유일한 파일 (2026-10-12 스펙). 네이티브 모듈이 없는 빌드(GOOGLE_SERVICES_* 없음, Expo Go)에서는
 * require가 던지거나 getApp()이 던진다 — 그 경우 모든 함수가 no-op이고 permission()은 "unavailable"이다.
 */
type Messaging = typeof import("@react-native-firebase/messaging");
type Loaded = { m: Messaging; inst: ReturnType<Messaging["getMessaging"]> };

let loaded: Loaded | null | undefined;
function fb(): Loaded | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require("@react-native-firebase/app") as typeof import("@react-native-firebase/app");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("@react-native-firebase/messaging") as Messaging;
    loaded = { m, inst: m.getMessaging(app.getApp()) };
  } catch {
    loaded = null;
  }
  return loaded;
}

const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS" as const;

async function androidGranted(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Platform.Version < 33) return true; // 13 미만은 런타임 권한이 없다
  return PermissionsAndroid.check(POST_NOTIFICATIONS);
}

export const push = {
  /** 디자인의 OS 상태 3가지 + 이 빌드에 Firebase가 없음 */
  async permission(): Promise<PushPermission> {
    const f = fb();
    if (!f) return "unavailable";
    if (Platform.OS === "android") {
      if (await androidGranted()) return "allowed";
      // Android는 "안 물어봄"과 "거부"를 구분해 주지 않는다 — 우리가 물었는지로 가른다
      return (await secureStorage.get("pushAsked")) ? "denied" : "ask";
    }
    const status = await f.m.hasPermission(f.inst);
    const S = f.m.AuthorizationStatus;
    if (status === S.AUTHORIZED || status === S.PROVISIONAL) return "allowed";
    return status === S.NOT_DETERMINED ? "ask" : "denied";
  },

  /** OS 다이얼로그. 결과를 바로 돌려준다 */
  async request(): Promise<PushPermission> {
    const f = fb();
    if (!f) return "unavailable";
    await secureStorage.set("pushAsked", "1");
    if (Platform.OS === "android") {
      if (Platform.Version < 33) return "allowed";
      const r = await PermissionsAndroid.request(POST_NOTIFICATIONS);
      return r === PermissionsAndroid.RESULTS.GRANTED ? "allowed" : "denied";
    }
    const status = await f.m.requestPermission(f.inst);
    return status === f.m.AuthorizationStatus.AUTHORIZED || status === f.m.AuthorizationStatus.PROVISIONAL ? "allowed" : "denied";
  },

  async getToken(): Promise<string | null> {
    const f = fb();
    if (!f) return null;
    try {
      return await f.m.getToken(f.inst);
    } catch (err) {
      console.warn("fcm getToken failed", err);
      return null;
    }
  },

  onTokenRefresh(cb: (token: string) => void): () => void {
    const f = fb();
    return f ? f.m.onTokenRefresh(f.inst, cb) : () => undefined;
  },

  /** 백그라운드/종료 상태에서 푸시를 눌러 열었을 때. 콜드 스타트 건은 구독 직후 한 번 전달된다 */
  onOpened(cb: (t: PendingTarget) => void): () => void {
    const f = fb();
    if (!f) return () => undefined;
    let cancelled = false;
    void f.m.getInitialNotification(f.inst).then((msg) => {
      const t = parsePushData(msg?.data);
      if (t && !cancelled) cb(t);
    });
    const off = f.m.onNotificationOpenedApp(f.inst, (msg) => {
      const t = parsePushData(msg.data);
      if (t) cb(t);
    });
    return () => {
      cancelled = true;
      off();
    };
  },

  /** 앱이 켜져 있을 때 도착 — 배너 없이 배지·인박스만 갱신한다 (스펙 결정 11) */
  onForegroundMessage(cb: () => void): () => void {
    const f = fb();
    return f ? f.m.onMessage(f.inst, () => cb()) : () => undefined;
  },

  openSystemSettings(): void {
    void Linking.openSettings();
  },

  platform(): "ios" | "android" {
    return Platform.OS === "ios" ? "ios" : "android";
  },

  locale(): string {
    return getLocales()[0]?.languageTag ?? "en";
  },
};

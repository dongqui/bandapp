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

// 콜드 스타트 알림은 앱 생애 동안 한 번만 전달한다 — 효과 재마운트/StrictMode 이중 호출로
// getInitialNotification이 다시 같은 알림을 돌려줘도 두 번 이동하지 않게 모듈 수준에서 막는다.
let initialDelivered = false;

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
      try {
        return (await secureStorage.get("pushAsked")) ? "denied" : "ask";
      } catch (err) {
        // 저장소를 읽지 못하면 아직 안 물어본 것으로 본다
        console.warn("pushAsked read failed", err);
        return "ask";
      }
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
    try {
      let result: PushPermission;
      if (Platform.OS === "android") {
        if (Platform.Version < 33) return "allowed"; // 다이얼로그가 없다 — 플래그도 필요 없다
        const r = await PermissionsAndroid.request(POST_NOTIFICATIONS);
        result = r === PermissionsAndroid.RESULTS.GRANTED ? "allowed" : "denied";
      } else {
        const status = await f.m.requestPermission(f.inst);
        result = status === f.m.AuthorizationStatus.AUTHORIZED || status === f.m.AuthorizationStatus.PROVISIONAL ? "allowed" : "denied";
      }
      // 다이얼로그가 실제로 끝난 뒤에만 "물어봤음"을 남긴다 (Android의 ask/denied 구분 근거)
      await secureStorage.set("pushAsked", "1").catch((err) => console.warn("pushAsked save failed", err));
      return result;
    } catch (err) {
      // 네이티브 오류로 다이얼로그가 뜨지 못했다 — 플래그를 남기지 않고 "ask"로 두어 설정 카드가 다시 "켜기"를 보여준다
      console.warn("push permission request failed", err);
      return "ask";
    }
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

  /** 백그라운드/종료 상태에서 푸시를 눌러 열었을 때. 콜드 스타트 건은 앱 생애 동안 한 번만 전달된다 */
  onOpened(cb: (t: PendingTarget) => void): () => void {
    const f = fb();
    if (!f) return () => undefined;
    const deliver = (t: PendingTarget) => {
      try {
        cb(t);
      } catch (err) {
        console.warn("push onOpened handler failed", err);
      }
    };
    let cancelled = false;
    void f.m
      .getInitialNotification(f.inst)
      .then((msg) => {
        const t = parsePushData(msg?.data);
        if (!t || cancelled || initialDelivered) return;
        initialDelivered = true;
        deliver(t);
      })
      .catch((err) => console.warn("fcm getInitialNotification failed", err));
    const off = f.m.onNotificationOpenedApp(f.inst, (msg) => {
      const t = parsePushData(msg.data);
      if (t) deliver(t);
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

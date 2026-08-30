import { AuthCancelledError } from "../errors";

// Expo Go에는 google-signin 네이티브 모듈이 없다 — 정적 import 대신 호출 시점 lazy import로
// Mock 모드(Expo Go)에서 앱이 깨지지 않게 한다. 실제 로그인은 dev build에서만 동작.
let configured = false;

export async function googleIdToken(): Promise<string> {
  const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
  if (!configured) {
    const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    if (!webClientId) throw new Error("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set");
    GoogleSignin.configure({ webClientId });
    configured = true;
  }
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (result.type === "cancelled") throw new AuthCancelledError();
  const idToken = result.data.idToken;
  if (!idToken) throw new Error("google sign-in returned no idToken");
  return idToken;
}

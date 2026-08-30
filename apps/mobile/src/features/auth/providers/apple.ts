import * as AppleAuthentication from "expo-apple-authentication";
import { AuthCancelledError } from "../errors";

export async function appleCredential(): Promise<{ idToken: string; displayName?: string }> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    const idToken = credential.identityToken;
    if (!idToken) throw new Error("apple sign-in returned no identityToken");
    // 이름은 최초 인증 때만 온다 — 서버가 최초 가입 시에만 저장 (스펙 결정 8)
    const displayName = [credential.fullName?.familyName, credential.fullName?.givenName]
      .filter(Boolean)
      .join("");
    return { idToken, displayName: displayName || undefined };
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_REQUEST_CANCELED") throw new AuthCancelledError();
    throw err;
  }
}

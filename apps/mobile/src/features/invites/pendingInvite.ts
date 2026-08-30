import { secureStorage } from "@/services/secure-storage";

export function savePendingInviteToken(token: string): Promise<void> {
  return secureStorage.set("pendingInviteToken", token);
}

/** 저장된 초대 토큰을 반환하고 지운다 — 로그인 직후 한 번만 소비된다 (기획서 14장). */
export async function resolvePendingInvite(): Promise<string | null> {
  const token = await secureStorage.get("pendingInviteToken");
  if (token) await secureStorage.remove("pendingInviteToken");
  return token;
}

export type GateStatus = "restoring" | "guest" | "authenticated";

const PUBLIC_SEGMENTS = new Set(["login", "invite"]);

/** 루트 세그먼트 기준 리다이렉트 결정. null이면 그대로 둔다. */
export function gate(status: GateStatus, firstSegment: string | undefined): { redirect: string } | null {
  if (status === "restoring") return null;
  const segment = firstSegment ?? "";
  if (status === "guest" && !PUBLIC_SEGMENTS.has(segment)) return { redirect: "/login" };
  if (status === "authenticated" && segment === "login") return { redirect: "/" };
  return null;
}

// 설정 화면은 Me 탭으로 흡수됐다(2026-10-06). 탭은 밴드가 있어야 보이므로 예외가 아니다
const BAND_EXEMPT_SEGMENTS = new Set(["onboarding", "invite", "login"]);

/**
 * 밴드 0개인 인증 사용자를 온보딩으로 보낸다 (기획서 10장).
 * bandsCount가 null이면 로딩 중이므로 리다이렉트하지 않는다.
 */
export function bandGate(
  bandsCount: number | null,
  firstSegment: string | undefined,
): { redirect: string } | null {
  if (bandsCount === null || bandsCount > 0) return null;
  const segment = firstSegment ?? "";
  if (BAND_EXEMPT_SEGMENTS.has(segment)) return null;
  return { redirect: "/onboarding" };
}

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

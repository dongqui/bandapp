/**
 * 결제 화면이 어디서 열렸는지 — 분석 대기 세션에서 왔으면 성공 뒤 "Continue analysis"를 보여준다 (디자인 billCtx).
 * "me"는 Me 탭의 구독 카드에서 온 경우: B01a 뒤로가기 라벨이 "Me"고, 완료 뒤 Me로 돌아간다.
 */
export type BillingCtx =
  | { from: "band" }
  | { from: "me" }
  | { from: "analysis"; sessionId: string; title: string; durationSec: number };

export function ctxToParams(ctx: BillingCtx): Record<string, string> {
  if (ctx.from === "analysis") {
    return { from: "analysis", sessionId: ctx.sessionId, title: ctx.title, durationSec: String(ctx.durationSec) };
  }
  return { from: ctx.from };
}

export function paramsToCtx(p: Record<string, string | string[] | undefined>): BillingCtx {
  const s = (k: string) => (Array.isArray(p[k]) ? p[k]![0] : p[k]) ?? "";
  if (s("from") === "analysis" && s("sessionId")) {
    return { from: "analysis", sessionId: s("sessionId"), title: s("title"), durationSec: Number(s("durationSec")) || 0 };
  }
  if (s("from") === "me") return { from: "me" };
  return { from: "band" };
}

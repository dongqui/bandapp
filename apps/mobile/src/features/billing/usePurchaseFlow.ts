import { MockApiClient } from "@bandapp/api-client";
import type { BandBilling } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { useApi } from "@/api";
import { purchases, type ProductKey } from "@/services/purchases";
import { ctxToParams, type BillingCtx } from "./billingContext";
import { phaseAfterSync, type PurchasePhase } from "./billingView";

/**
 * 스토어 구매 → 서버 sync → B06. 사용자가 취소하면 현재 화면에 머문다.
 * Mock 모드에서는 purchases.purchase가 성공을 흉내 내고, 상태 변화는 MockApiClient.mockPurchase가 만든다.
 */
export function usePurchaseFlow(bandId: string) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // 연타 방지는 렌더 클로저가 아니라 ref로 동기 검사한다
  const busyRef = useRef(false);

  // 구매 전 기준값을 함께 넘긴다 — 상태 화면이 뒤늦게 받은 서버 상태엔 이미 구매가 반영됐을 수 있다
  const toStatus = (phase: PurchasePhase, product: ProductKey, ctx: BillingCtx, ret: string, before: BandBilling) =>
    router.replace({
      pathname: "/billing/status",
      params: {
        bandId, phase, product, ret, ...ctxToParams(ctx),
        beforeExtraSec: String(before.extraSec), beforePlan: before.plan ?? "", beforeState: before.state,
      },
    });

  return {
    busy,
    async buy(product: ProductKey, before: BandBilling, ctx: BillingCtx, ret: "/billing/plans" | "/billing/extra") {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const outcome = await purchases.purchase(product, { bandId, currentPlan: before.state === "linked" ? before.plan : null });
        if (outcome === "cancelled") return;
        if (api instanceof MockApiClient && outcome === "success") api.mockPurchase(product, bandId);
        // 스토어가 끝났으니 서버에 알린다. sync가 죽어도 구매는 유효 — delayed로 보내 "Check status"가 다시 부른다
        const after = outcome === "success" ? await api.billing.sync(bandId).catch(() => null) : null;
        toStatus(phaseAfterSync(outcome, before, after, product), product, ctx, ret, before);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    async manage(kind: "cancel" | "resume", before: BandBilling, ctx: BillingCtx) {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        // 스토어 화면을 못 열어도 sync는 이어간다 — willRenew가 안 바뀌면 delayed로 간다
        await purchases.manageSubscriptions().catch(() => undefined);
        // 스토어 화면에서 돌아온 뒤 — 실제로 바꿨는지는 sync 결과의 willRenew로 안다
        const after = await api.billing.sync(bandId).catch(() => null);
        const product = (before.plan ?? "band") as ProductKey;
        const changed = after ? after.willRenew !== before.willRenew : false;
        toStatus(changed ? (kind === "cancel" ? "canceled" : "resumed") : "delayed", product, ctx, "/billing/plans", before);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
  };
}

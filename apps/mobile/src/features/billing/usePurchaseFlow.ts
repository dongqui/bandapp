import { MockApiClient } from "@bandapp/api-client";
import type { BandBilling } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useState } from "react";
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

  const toStatus = (phase: PurchasePhase, product: ProductKey, ctx: BillingCtx, ret: string) =>
    router.replace({ pathname: "/billing/status", params: { bandId, phase, product, ret, ...ctxToParams(ctx) } });

  return {
    busy,
    async buy(product: ProductKey, before: BandBilling, ctx: BillingCtx, ret: "/billing/plans" | "/billing/extra") {
      if (busy) return;
      setBusy(true);
      try {
        const outcome = await purchases.purchase(product, { bandId, currentPlan: before.state === "linked" ? before.plan : null });
        if (outcome === "cancelled") return;
        if (api instanceof MockApiClient && outcome === "success") api.mockPurchase(product, bandId);
        // 스토어가 끝났으니 서버에 알린다. sync가 죽어도 구매는 유효 — delayed로 보내 "Check status"가 다시 부른다
        const after = outcome === "success" ? await api.billing.sync(bandId).catch(() => null) : null;
        toStatus(phaseAfterSync(outcome, before, after, product), product, ctx, ret);
      } finally {
        setBusy(false);
      }
    },
    async manage(kind: "cancel" | "resume", before: BandBilling, ctx: BillingCtx) {
      if (busy) return;
      setBusy(true);
      try {
        await purchases.manageSubscriptions();
        // 스토어 화면에서 돌아온 뒤 — 실제로 바꿨는지는 sync 결과의 willRenew로 안다
        const after = await api.billing.sync(bandId).catch(() => null);
        const product = (before.plan ?? "band") as ProductKey;
        const changed = after ? after.willRenew !== before.willRenew : false;
        toStatus(changed ? (kind === "cancel" ? "canceled" : "resumed") : "delayed", product, ctx, "/billing/plans");
      } finally {
        setBusy(false);
      }
    },
  };
}

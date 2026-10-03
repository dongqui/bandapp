import { Platform } from "react-native";
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  type GoogleProductChangeInfo,
} from "react-native-purchases";
import { purchasesMock } from "./purchases.mock";

export type ProductKey = "band" | "plus" | "extra";
export interface StorePrice {
  key: ProductKey;
  priceString: string;
}
export type PurchaseOutcome = "success" | "cancelled" | "pending" | "failed";

export interface PurchasesApi {
  configure(): void;
  logIn(userId: string): Promise<void>;
  logOut(): Promise<void>;
  prices(): Promise<StorePrice[]>;
  purchase(key: ProductKey, opts: { bandId: string; currentPlan: "band" | "plus" | null }): Promise<PurchaseOutcome>;
  manageSubscriptions(): Promise<void>;
  storeName(): "App Store" | "Google Play";
}

/** 서버 billing/plans.ts와 같은 값. 바꾸면 양쪽을 같이 바꾼다 */
export const PRODUCT_IDS: Record<ProductKey, string> = {
  band: "rehearsal.band.monthly",
  plus: "rehearsal.plus.monthly",
  extra: "rehearsal.extra.3h",
};

function keyOf(productId: string): ProductKey | null {
  return (Object.keys(PRODUCT_IDS) as ProductKey[]).find((k) => PRODUCT_IDS[k] === productId) ?? null;
}

/** Android는 기존 구독을 교체해야 업·다운그레이드가 된다. iOS는 같은 구독 그룹이라 스토어가 처리 */
function upgradeInfo(key: ProductKey, currentPlan: "band" | "plus" | null): GoogleProductChangeInfo | null {
  if (Platform.OS !== "android" || key === "extra" || !currentPlan || currentPlan === key) return null;
  return { oldProductIdentifier: PRODUCT_IDS[currentPlan] };
}

const real: PurchasesApi = {
  configure() {
    const apiKey = Platform.OS === "ios" ? process.env.EXPO_PUBLIC_RC_IOS_KEY : process.env.EXPO_PUBLIC_RC_ANDROID_KEY;
    if (!apiKey) {
      console.warn("[purchases] RevenueCat key가 없어 결제가 동작하지 않는다 (.env.example 참고)");
      return;
    }
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
    Purchases.configure({ apiKey });
  },
  async logIn(userId) {
    // 우리 users.id가 RevenueCat app_user_id — 서버 웹훅이 이 값으로 사용자를 찾는다
    await Purchases.logIn(userId);
  },
  async logOut() {
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  },
  async prices() {
    const offerings = await Purchases.getOfferings();
    const packages = offerings.current?.availablePackages ?? [];
    return packages
      .map((p) => ({ key: keyOf(p.product.identifier), priceString: p.product.priceString }))
      .filter((x): x is StorePrice => x.key !== null);
  },
  async purchase(key, { bandId, currentPlan }) {
    const offerings = await Purchases.getOfferings();
    const pkg = offerings.current?.availablePackages.find((p) => p.product.identifier === PRODUCT_IDS[key]);
    if (!pkg) return "failed";
    // 소모성은 어느 밴드 것인지 웹훅이 알 수 있게 속성으로 남긴다 (앱이 sync를 못 부르고 죽는 경우 대비)
    await Purchases.setAttributes({ band_id: bandId });
    try {
      // 2번째 인자는 deprecated UpgradeInfo — 3번째 productChangeInfo를 쓴다
      await Purchases.purchasePackage(pkg, null, upgradeInfo(key, currentPlan));
      return "success";
    } catch (e) {
      const err = e as { code?: string; userCancelled?: boolean };
      if (err.userCancelled || err.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return "cancelled";
      if (err.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) return "pending";
      return "failed";
    }
  },
  async manageSubscriptions() {
    await Purchases.showManageSubscriptions();
  },
  storeName() {
    return Platform.OS === "ios" ? "App Store" : "Google Play";
  },
};

export const purchases: PurchasesApi = process.env.EXPO_PUBLIC_API_URL ? real : purchasesMock;

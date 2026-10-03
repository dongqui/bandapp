import type { PurchasesApi } from "./purchases";

/**
 * 웹 프리뷰·Expo Go용. 가격은 디자인 프로토타입 값, 구매는 0.8초 뒤 성공.
 * 실제 상태 변화는 화면이 MockApiClient.mockPurchase로 만든다 (purchase 성공 뒤 sync 전에).
 */
export const purchasesMock: PurchasesApi = {
  configure() {},
  async logIn() {},
  async logOut() {},
  async prices() {
    await new Promise((r) => setTimeout(r, 800));
    return [
      { key: "band", priceString: "$15" },
      { key: "plus", priceString: "$25" },
      { key: "extra", priceString: "$3" },
    ];
  },
  async purchase() {
    await new Promise((r) => setTimeout(r, 800));
    return "success";
  },
  async manageSubscriptions() {},
  storeName() {
    return "App Store";
  },
};

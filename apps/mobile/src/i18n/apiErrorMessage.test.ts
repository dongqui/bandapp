import { ApiError } from "@bandapp/api-client";
import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { apiErrorMessage } from "./apiErrorMessage";
import { en } from "./en";
import { ko } from "./ko";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "ko",
    fallbackLng: "en",
    resources: { en: { translation: en }, ko: { translation: ko } },
    interpolation: { escapeValue: false },
  });
});

describe("apiErrorMessage", () => {
  it("아는 code면 번역한다", () => {
    expect(apiErrorMessage(new ApiError(403, "server text", "band_owner_only"), i18n.t)).toBe(
      ko.errors.band_owner_only,
    );
  });

  it("모르는 code나 code 없음이면 서버 메시지", () => {
    expect(apiErrorMessage(new ApiError(500, "서버 문구", "something_new"), i18n.t)).toBe("서버 문구");
    expect(apiErrorMessage(new ApiError(500, "서버 문구"), i18n.t)).toBe("서버 문구");
  });

  it("ApiError가 아니면 generic", () => {
    expect(apiErrorMessage(new Error("boom"), i18n.t)).toBe(ko.errors.generic);
    expect(apiErrorMessage(undefined, i18n.t)).toBe(ko.errors.generic);
  });
});

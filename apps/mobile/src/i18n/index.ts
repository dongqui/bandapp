import { getLocales } from "expo-localization";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { ko } from "./ko";
import "./types";

type Lang = "en" | "ko";

function deviceLanguage(): Lang {
  const code = getLocales()[0]?.languageCode ?? "en";
  return code === "ko" ? "ko" : "en";
}

// 동기 초기화 — 리소스가 번들에 있어 로딩이 없고, 첫 렌더 전에 t()가 준비된다.
// 언어 전환 UI는 없다. 기기 언어만 따른다 (2026-09-08 스펙 결정 9).
void i18next.use(initReactI18next).init({
  lng: deviceLanguage(),
  fallbackLng: "en",
  resources: { en: { translation: en }, ko: { translation: ko } },
  interpolation: { escapeValue: false }, // React Native는 HTML 이스케이프가 필요 없다
  // i18next v26에서 initImmediate가 initAsync로 이름만 바뀌었다. 의미는 그대로 — false가 동기 초기화다.
  initAsync: false,
});

export { i18next };
export type { Resource } from "./types";

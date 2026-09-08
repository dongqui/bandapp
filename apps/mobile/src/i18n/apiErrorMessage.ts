import { ApiError } from "@bandapp/api-client";
import type { TFunction } from "i18next";
import { en } from "./en";

/**
 * 서버 오류를 사용자 문구로. code가 errors.*에 있으면 번역, 없으면 서버 message 그대로,
 * ApiError가 아니면(네트워크 등) generic (2026-09-08 스펙 결정 8).
 */
export function apiErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    if (err.code && err.code in en.errors) {
      return t(`errors.${err.code as keyof typeof en.errors}`);
    }
    return err.message;
  }
  return t("errors.generic");
}

import { BAND_PART_PRESETS, type BandPartPreset } from "@bandapp/types";
import type { TFunction } from "i18next";

export function isPreset(part: string): part is BandPartPreset {
  return (BAND_PART_PRESETS as readonly string[]).includes(part);
}

/** 프리셋 키면 현재 언어로, 자유 문자열이면 그대로, null이면 "미설정" 문구 (2026-09-08 스펙 결정 1). */
export function partLabel(part: string | null, t: TFunction): string {
  if (part === null) return t("band.part.none");
  return isPreset(part) ? t(`band.part.preset.${part}`) : part;
}

/**
 * 직접 입력을 저장 값으로. trim → 빈 값이면 null → 현재 언어의 프리셋 라벨이나 키와
 * 대소문자 무시 일치하면 키로 정규화, 아니면 친 그대로. 길이 제한은 서버가 맡는다.
 */
export function normalizePartInput(input: string, t: TFunction): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  for (const key of BAND_PART_PRESETS) {
    if (lower === key || lower === t(`band.part.preset.${key}`).toLowerCase()) return key;
  }
  return trimmed;
}

import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

function leafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? leafKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("i18n resources", () => {
  it("ko와 en의 키가 같다", () => {
    expect(leafKeys(ko).sort()).toEqual(leafKeys(en).sort());
  });

  it("보간 변수가 양쪽에서 같다", () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const flatEn = Object.fromEntries(leafKeys(en).map((k) => [k, k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], en) as string]));
    const flatKo = Object.fromEntries(leafKeys(ko).map((k) => [k, k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], ko) as string]));
    for (const k of Object.keys(flatEn)) expect(vars(flatKo[k]!), k).toEqual(vars(flatEn[k]!));
  });

  it("count를 보간 변수로 쓰지 않는다 (i18next 복수형과 충돌)", () => {
    for (const k of leafKeys(en)) {
      const v = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], en) as string;
      expect(v, k).not.toMatch(/\{\{count\}\}/);
    }
  });
});

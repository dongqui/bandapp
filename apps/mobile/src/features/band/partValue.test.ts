import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { ko } from "../../i18n/ko";
import { isPreset, normalizePartInput, partLabel } from "./partValue";

const enI = i18next.createInstance();
const koI = i18next.createInstance();
beforeAll(async () => {
  const resources = { en: { translation: en }, ko: { translation: ko } };
  await enI.init({ lng: "en", resources, interpolation: { escapeValue: false } });
  await koI.init({ lng: "ko", resources, interpolation: { escapeValue: false } });
});

describe("partLabel", () => {
  it("프리셋 키는 현재 언어로 번역한다", () => {
    expect(partLabel("guitar", enI.t)).toBe("Guitar");
    expect(partLabel("guitar", koI.t)).toBe("기타");
    expect(partLabel("keyboard", enI.t)).toBe("Keys");
  });

  it("자유 문자열은 그대로, null은 '미설정' 문구", () => {
    expect(partLabel("Synth", koI.t)).toBe("Synth");
    expect(partLabel(null, enI.t)).toBe(en.band.part.none);
  });
});

describe("normalizePartInput", () => {
  it("trim하고 빈 값은 null", () => {
    expect(normalizePartInput("  Sax ", enI.t)).toBe("Sax");
    expect(normalizePartInput("   ", enI.t)).toBeNull();
  });

  it("현재 언어의 프리셋 라벨과 대소문자 무시 일치하면 키로", () => {
    expect(normalizePartInput("guitar", enI.t)).toBe("guitar");
    expect(normalizePartInput("KEYS", enI.t)).toBe("keyboard");
    expect(normalizePartInput("기타", koI.t)).toBe("guitar");
    expect(normalizePartInput("건반", koI.t)).toBe("keyboard");
  });

  it("프리셋 키 자체를 쳐도 키로", () => {
    expect(normalizePartInput("Drums", koI.t)).toBe("drums");
  });

  it("20자를 넘으면 잘라내지 않고 그대로 돌려준다 — 길이는 서버가 400으로 막는다", () => {
    const long = "a".repeat(25);
    expect(normalizePartInput(long, enI.t)).toBe(long);
  });
});

describe("isPreset", () => {
  it("키 판별", () => {
    expect(isPreset("vocal")).toBe(true);
    expect(isPreset("Vocals")).toBe(false);
  });
});

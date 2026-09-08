# 팀 관리 화면 + i18n 인프라 (모바일) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 밴드 탭을 디자인대로 만든다 — 파트 표시·변경(프리셋 + 직접 입력), owner의 팀원 관리(내보내기·owner 지정), 밴드 이름 변경·소유권 이전·나가기·삭제 — 그리고 이 화면의 모든 문구를 i18n 리소스(ko/en)로 넣는다.

**Architecture:** `src/i18n/`이 i18next를 초기화하고 `en`을 타입 원본으로 하는 ko/en 리소스를 제공한다. 밴드 화면은 `BandScreen`이 `sheet`·`confirm` 두 유니온 상태를 들고, 실제 API 호출·토스트·오류 번역은 `useBandActions` 훅이 맡는다. 시트 5개와 `ConfirmDialog`는 표시만 하고 콜백을 올린다. Mock 모드에서 b1(owner)·b2(member) 두 밴드로 두 상태를 웹 프리뷰에서 본다.

**Tech Stack:** Expo SDK 57 (dev build), expo-router, i18next + react-i18next + expo-localization, `@bandapp/api-client`, vitest.

**스펙:** [docs/superpowers/specs/2026-09-08-team-management-screen-design.md](../specs/2026-09-08-team-management-screen-design.md)
**선행 플랜:** [2026-09-08-team-management-server.md](2026-09-08-team-management-server.md) — Task 6까지 끝나 있어야 한다 (`bands.rename/transferOwnership/delete`, `ApiError.code`, Mock 시드 b1/b2).

## Global Constraints

- Expo SDK 57 API만 쓴다 (`apps/mobile/AGENTS.md`: https://docs.expo.dev/versions/v57.0.0/).
- `expo-localization`은 네이티브 모듈이다. 추가 후 dev build를 다시 만들어야 한다 (`pnpm --filter mobile ios`는 맥에서). Windows에서는 `pnpm --filter mobile typecheck`, `pnpm --filter mobile test`, 웹 프리뷰(`.claude/launch.json`의 `mobile-web-mock`)까지 검증한다.
- 이번 화면의 문구는 **전부** `src/i18n` 리소스에서 온다. 하드코딩 문자열 금지. 기존 화면(세션·녹음·설정·초대 랜딩)의 문구는 건드리지 않는다.
- 리소스 키 구조는 스펙의 "모바일 i18n 인프라" 절과 같다. `en`이 타입 원본, `ko: Resource`.
- 복수형 충돌을 피해 보간 변수 이름으로 `count`를 쓰지 않는다 (`n`을 쓴다).
- 파트 프리셋은 `@bandapp/types`의 `BAND_PART_PRESETS`를 쓴다. 프리셋은 **키**로 저장하고 표시할 때 번역한다. 자유 문자열은 그대로 저장·표시한다.
- owner 판정은 멤버 목록에서 내 id의 `role`. 목록을 아직 못 불러왔으면 member로 취급한다.
- 밴드 이름 변경·소유권 이전·삭제·초대 버튼은 owner에게만 보인다. 나가기는 전원.
- 모바일 vitest는 설정 파일 없이 `vitest run src`로 돈다 — 테스트 대상 모듈과 테스트 파일은 `@/` 별칭을 쓰지 말고 **상대 경로**로 import한다.
- UI 컴포넌트는 `@/ui`와 `@/theme` 토큰만 쓴다. 새 스타일 의존성 금지.
- 커밋 메시지는 영어 conventional commit, 본문 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## 파일 구조

```
apps/mobile/package.json                          i18next, react-i18next, expo-localization
apps/mobile/src/i18n/en.ts                        영어 리소스 (타입 원본)
apps/mobile/src/i18n/ko.ts                        한국어 리소스 (Resource 타입 강제)
apps/mobile/src/i18n/types.ts                     Resource 타입 + i18next 모듈 확장
apps/mobile/src/i18n/index.ts                     초기화 (기기 언어 감지, 리소스 등록)
apps/mobile/src/i18n/resources.test.ts            ko/en 키 동형 검사
apps/mobile/src/i18n/apiErrorMessage.ts (+test)   ApiError.code → 번역
apps/mobile/app/_layout.tsx                       "@/i18n" import
apps/mobile/src/features/band/partValue.ts (+test) partLabel · normalizePartInput
apps/mobile/src/ui/ConfirmDialog.tsx              중앙 확인 다이얼로그
apps/mobile/src/ui/index.ts                       ConfirmDialog export
apps/mobile/src/features/band/SheetRow.tsx        시트 안의 행 (제목·부제·우측·danger)
apps/mobile/src/features/band/MemberHeader.tsx    시트 상단 아바타·이름·부제
apps/mobile/src/features/band/MemberRow.tsx       파트·OWNER 배지·chevron
apps/mobile/src/features/band/PartSheet.tsx       프리셋 + 직접 입력
apps/mobile/src/features/band/SelfMemberSheet.tsx 본인: 파트 변경 · (owner) 이전
apps/mobile/src/features/band/MemberSheet.tsx     타인(owner 전용): owner 지정 · 내보내기
apps/mobile/src/features/band/TransferSheet.tsx   이전 대상 선택
apps/mobile/src/features/band/RenameSheet.tsx     이름 입력
apps/mobile/src/features/band/InviteSheet.tsx     문구만 i18n
apps/mobile/src/features/band/useBandActions.ts   API 호출·토스트·오류 번역·이동
apps/mobile/src/features/band/BandScreen.tsx      화면 조립
```

---

### Task 1: i18n 인프라

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/i18n/en.ts`, `ko.ts`, `types.ts`, `index.ts`, `resources.test.ts`
- Modify: `apps/mobile/app/_layout.tsx:1`

**Interfaces:**
- Produces: `import "@/i18n"`(부작용: 초기화), `useTranslation()`(react-i18next), `type Resource`, `en`, `ko`.
- 키 목록은 아래 `en.ts`가 정본이다. 이후 태스크는 이 키만 쓴다.

- [ ] **Step 1: 패키지 설치**

Run: `cd apps/mobile && npx expo install expo-localization && pnpm add i18next react-i18next`
Expected: `package.json`에 `expo-localization ~17.x`, `i18next ^25.x`, `react-i18next ^16.x`. 루트에서 `pnpm install`이 lockfile을 갱신한다.

- [ ] **Step 2: 실패하는 리소스 동형 테스트 작성**

`apps/mobile/src/i18n/resources.test.ts`:

```ts
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
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter mobile test`
Expected: FAIL — `./en` 없음.

- [ ] **Step 4: 영어 리소스**

`apps/mobile/src/i18n/en.ts`:

```ts
/** 타입 원본. ko.ts는 이 모양을 그대로 따라야 한다 (2026-09-08 스펙 결정 9). */
export const en = {
  common: {
    cancel: "Cancel",
    save: "Save",
    you: "(You)",
  },
  band: {
    header: {
      yourBand: "YOUR BAND",
      members: "MEMBERS · {{n}}",
    },
    invite: {
      button: "+ Invite member",
      title: "Invite your band",
      subtitle: "Send a link to invite members.",
      copy: "Copy link",
      copied: "Copied",
    },
    manage: {
      title: "MANAGE",
      bandName: "Band name",
      transfer: "Transfer ownership",
      leave: "Leave band",
      delete: "Delete band",
    },
    role: {
      owner: "Owner",
      member: "Member",
    },
    part: {
      title: "Your part",
      subtitle: "Shown next to your name in the band.",
      placeholder: "Or type your own — e.g. Synth, Sax…",
      none: "No part set",
      preset: {
        vocal: "Vocals",
        guitar: "Guitar",
        bass: "Bass",
        drums: "Drums",
        keyboard: "Keys",
      },
    },
    self: {
      changePart: "Change part",
      transfer: "Transfer ownership",
      transferSubtitle: "Hand the owner role to another member",
    },
    member: {
      makeOwner: "Make owner",
      makeOwnerSubtitle: "Transfer ownership of the band",
      remove: "Remove from band",
    },
    transfer: {
      title: "Transfer ownership",
      subtitle: "The new owner manages members and band settings.",
    },
    rename: {
      title: "Band name",
    },
    confirm: {
      remove: {
        title: "Remove {{name}}?",
        body: "They’ll lose access to all of {{band}}’s sessions and feedback. You can invite them again later.",
        primary: "Remove",
      },
      transfer: {
        title: "Make {{name}} the owner?",
        body: "They’ll manage members and band settings. You’ll become a member.",
        primary: "Transfer ownership",
      },
      delete: {
        title: "Delete {{band}}?",
        body: "All sessions, takes, and feedback will be permanently deleted for every member. This can’t be undone.",
        primary: "Delete band",
      },
      leave: {
        title: "Leave {{band}}?",
        body: "You’ll lose access to its sessions and feedback. You can rejoin with an invite link.",
        primary: "Leave band",
      },
      ownerLeave: {
        title: "Transfer ownership first",
        body: "You’re the owner of {{band}}. To leave, hand ownership to another member — or delete the band.",
        primary: "Transfer ownership",
        secondary: "Delete band",
      },
    },
    toast: {
      removed: "{{name}} removed from the band",
      transferred: "{{name}} is now the owner",
      deleted: "Band deleted",
      left: "You left {{band}}",
      renamed: "Band renamed",
      partSet: "Part set to {{part}}",
    },
  },
  errors: {
    generic: "Something went wrong. Please try again.",
    band_forbidden: "You no longer have access to this band.",
    band_owner_only: "Only the band owner can do that.",
    band_owner_must_transfer: "Transfer ownership or delete the band first.",
    band_member_not_found: "That member isn’t in the band anymore.",
    band_cannot_remove_self: "You can’t remove yourself. Use Leave band instead.",
    band_cannot_remove_owner: "The owner can’t be removed.",
    band_transfer_self: "You’re already the owner.",
    invite_not_found: "This invite link isn’t valid.",
    invite_revoked: "This invite link is no longer active.",
    invite_expired: "This invite link has expired.",
    invite_exhausted: "This invite link has been used up.",
  },
};
```

- [ ] **Step 5: 타입과 한국어 리소스**

`apps/mobile/src/i18n/types.ts`:

```ts
import type { en } from "./en";

export type Resource = typeof en;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Resource };
  }
}
```

`apps/mobile/src/i18n/ko.ts`:

```ts
import type { Resource } from "./types";

/** 어투는 설정 화면·서버 메시지와 같은 "~해요". 키가 빠지면 타입체크가 잡는다. */
export const ko: Resource = {
  common: {
    cancel: "취소",
    save: "저장",
    you: "(나)",
  },
  band: {
    header: {
      yourBand: "YOUR BAND",
      members: "MEMBERS · {{n}}",
    },
    invite: {
      button: "+ 팀원 초대",
      title: "밴드에 초대하기",
      subtitle: "링크를 보내 팀원을 초대해요.",
      copy: "링크 복사",
      copied: "복사됨",
    },
    manage: {
      title: "MANAGE",
      bandName: "밴드 이름",
      transfer: "소유권 넘기기",
      leave: "밴드 나가기",
      delete: "밴드 삭제",
    },
    role: {
      owner: "관리자",
      member: "멤버",
    },
    part: {
      title: "내 파트",
      subtitle: "밴드에서 이름 옆에 표시돼요.",
      placeholder: "직접 입력 — 예: 신디, 색소폰…",
      none: "파트 미설정",
      preset: {
        vocal: "보컬",
        guitar: "기타",
        bass: "베이스",
        drums: "드럼",
        keyboard: "건반",
      },
    },
    self: {
      changePart: "파트 바꾸기",
      transfer: "소유권 넘기기",
      transferSubtitle: "다른 멤버에게 관리자 역할을 넘겨요",
    },
    member: {
      makeOwner: "관리자로 지정",
      makeOwnerSubtitle: "밴드 소유권을 넘겨요",
      remove: "밴드에서 내보내기",
    },
    transfer: {
      title: "소유권 넘기기",
      subtitle: "새 관리자가 멤버와 밴드 설정을 관리해요.",
    },
    rename: {
      title: "밴드 이름",
    },
    confirm: {
      remove: {
        title: "{{name}} 님을 내보낼까요?",
        body: "{{band}}의 모든 세션과 피드백을 더 볼 수 없게 돼요. 나중에 다시 초대할 수 있어요.",
        primary: "내보내기",
      },
      transfer: {
        title: "{{name}} 님을 관리자로 지정할까요?",
        body: "멤버와 밴드 설정을 관리하게 돼요. 나는 멤버가 돼요.",
        primary: "소유권 넘기기",
      },
      delete: {
        title: "{{band}}을(를) 삭제할까요?",
        body: "모든 세션, 테이크, 피드백이 모든 멤버에게서 영구 삭제돼요. 되돌릴 수 없어요.",
        primary: "밴드 삭제",
      },
      leave: {
        title: "{{band}}에서 나갈까요?",
        body: "세션과 피드백을 더 볼 수 없게 돼요. 초대 링크로 다시 참여할 수 있어요.",
        primary: "밴드 나가기",
      },
      ownerLeave: {
        title: "먼저 소유권을 넘겨 주세요",
        body: "{{band}}의 관리자예요. 나가려면 다른 멤버에게 소유권을 넘기거나 밴드를 삭제해야 해요.",
        primary: "소유권 넘기기",
        secondary: "밴드 삭제",
      },
    },
    toast: {
      removed: "{{name}} 님을 내보냈어요",
      transferred: "{{name}} 님이 관리자가 됐어요",
      deleted: "밴드를 삭제했어요",
      left: "{{band}}에서 나왔어요",
      renamed: "밴드 이름을 바꿨어요",
      partSet: "파트를 {{part}}(으)로 설정했어요",
    },
  },
  errors: {
    generic: "문제가 생겼어요. 다시 시도해 주세요.",
    band_forbidden: "이 밴드에 더 이상 접근할 수 없어요.",
    band_owner_only: "밴드 관리자만 할 수 있어요.",
    band_owner_must_transfer: "먼저 소유권을 넘기거나 밴드를 삭제해야 해요.",
    band_member_not_found: "이미 밴드에 없는 멤버예요.",
    band_cannot_remove_self: "자기 자신은 내보낼 수 없어요. 밴드 나가기를 사용해 주세요.",
    band_cannot_remove_owner: "관리자는 내보낼 수 없어요.",
    band_transfer_self: "이미 관리자예요.",
    invite_not_found: "유효하지 않은 초대 링크예요.",
    invite_revoked: "더 이상 사용할 수 없는 초대 링크예요.",
    invite_expired: "만료된 초대 링크예요.",
    invite_exhausted: "사용 횟수가 모두 찬 초대 링크예요.",
  },
};
```

- [ ] **Step 6: 초기화 모듈**

`apps/mobile/src/i18n/index.ts`:

```ts
import { getLocales } from "expo-localization";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { ko } from "./ko";
import "./types";

const SUPPORTED = ["en", "ko"] as const;

function deviceLanguage(): (typeof SUPPORTED)[number] {
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
  initImmediate: false,
});

export { i18next };
export type { Resource } from "./types";
```

- [ ] **Step 7: 루트 레이아웃에서 로드**

`apps/mobile/app/_layout.tsx` 맨 위(첫 import 앞)에 추가:

```ts
import "@/i18n";
```

- [ ] **Step 8: 테스트·타입체크**

Run: `pnpm --filter mobile test`
Expected: `resources.test.ts` 3개 PASS.

Run: `pnpm --filter mobile typecheck`
Expected: 통과. `ko`에서 키를 하나 지워 보고 타입 오류가 나는지 확인한 뒤 되돌린다.

- [ ] **Step 9: 커밋**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/src/i18n apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): add i18n infrastructure with ko/en resources for band management

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 오류 번역과 파트 값 헬퍼

**Files:**
- Create: `apps/mobile/src/i18n/apiErrorMessage.ts`, `apps/mobile/src/i18n/apiErrorMessage.test.ts`
- Create: `apps/mobile/src/features/band/partValue.ts`, `apps/mobile/src/features/band/partValue.test.ts`

**Interfaces:**
- Produces:
  - `apiErrorMessage(err: unknown, t: TFunction): string`
  - `partLabel(part: string | null, t: TFunction): string`
  - `normalizePartInput(input: string, t: TFunction): string | null`
  - `isPreset(part: string): part is BandPartPreset`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/mobile/src/i18n/apiErrorMessage.test.ts`:

```ts
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
```

`apps/mobile/src/features/band/partValue.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile test`
Expected: 두 파일 FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`apps/mobile/src/i18n/apiErrorMessage.ts`:

```ts
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
```

`apps/mobile/src/features/band/partValue.ts`:

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile test && pnpm --filter mobile typecheck`
Expected: PASS. (`@bandapp/api-client`·`@bandapp/types`는 `dist`를 읽는다 — 실패하면 `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client build`.)

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/i18n/apiErrorMessage.ts apps/mobile/src/i18n/apiErrorMessage.test.ts apps/mobile/src/features/band/partValue.ts apps/mobile/src/features/band/partValue.test.ts
git commit -m "feat(mobile): translate api error codes and normalize band part input

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: ConfirmDialog

**Files:**
- Create: `apps/mobile/src/ui/ConfirmDialog.tsx`
- Modify: `apps/mobile/src/ui/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ConfirmAction { label: string; onPress: () => void; }
  function ConfirmDialog(props: {
    visible: boolean; title: string; body: string;
    primary: ConfirmAction & { danger?: boolean };
    secondary?: ConfirmAction;   // danger 색 텍스트 버튼
    cancelLabel: string; onCancel: () => void;
    busy?: boolean;              // true면 primary·secondary 비활성
  }): JSX.Element
  ```

- [ ] **Step 1: 컴포넌트 작성**

`apps/mobile/src/ui/ConfirmDialog.tsx`:

```tsx
import { Modal, Pressable, View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export interface ConfirmAction {
  label: string;
  onPress: () => void;
}

/**
 * 디자인의 중앙 확인 다이얼로그. Alert.alert로는 보조 버튼 색과 본문 스타일을 못 맞춰 직접 만든다
 * (2026-09-08 스펙 결정 10). 주 버튼은 danger(빨강)/safe(accent), 보조는 빨간 텍스트, 취소는 회색 텍스트.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  primary,
  secondary,
  cancelLabel,
  onCancel,
  busy = false,
}: {
  visible: boolean;
  title: string;
  body: string;
  primary: ConfirmAction & { danger?: boolean };
  secondary?: ConfirmAction;
  cancelLabel: string;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", paddingHorizontal: 32 }}
        onPress={busy ? undefined : onCancel}
      >
        <Pressable
          onPress={() => undefined}
          style={{
            backgroundColor: colors.surfaceRaised,
            borderRadius: radius.chipLg,
            paddingTop: 24,
            paddingHorizontal: 20,
            paddingBottom: 14,
            gap: 8,
          }}
        >
          <AppText variant="sheetTitle">{title}</AppText>
          <AppText variant="caption" style={{ lineHeight: 20 }}>
            {body}
          </AppText>
          <View style={{ gap: 4, marginTop: 14 }}>
            <PressableOpacity
              onPress={primary.onPress}
              disabled={busy}
              style={{
                backgroundColor: primary.danger ? colors.danger : colors.accent,
                borderRadius: radius.input,
                paddingVertical: 13,
                alignItems: "center",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{primary.label}</AppText>
            </PressableOpacity>
            {secondary ? (
              <PressableOpacity
                onPress={secondary.onPress}
                disabled={busy}
                style={{ paddingVertical: 12, alignItems: "center", borderRadius: radius.input }}
              >
                <AppText style={{ fontSize: 14, color: colors.danger }}>{secondary.label}</AppText>
              </PressableOpacity>
            ) : null}
            <PressableOpacity
              onPress={onCancel}
              disabled={busy}
              style={{ paddingVertical: 12, alignItems: "center", borderRadius: radius.input }}
            >
              <AppText style={{ fontSize: 14, color: colors.textMuted }}>{cancelLabel}</AppText>
            </PressableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

`apps/mobile/src/ui/index.ts`에 `export * from "./ConfirmDialog";` 추가.

- [ ] **Step 2: 타입체크**

Run: `pnpm --filter mobile typecheck`
Expected: 통과. (`colors.accent`는 `useTheme()`가 주는 값이다 — 기존 `InviteSheet`가 같은 방식으로 쓴다.)

- [ ] **Step 3: 커밋**

```bash
git add apps/mobile/src/ui/ConfirmDialog.tsx apps/mobile/src/ui/index.ts
git commit -m "feat(mobile): add ConfirmDialog with danger/safe primary and optional secondary action

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 시트 공통 조각과 MemberRow · PartSheet · SelfMemberSheet

**Files:**
- Create: `apps/mobile/src/features/band/SheetRow.tsx`, `MemberHeader.tsx`, `PartSheet.tsx`, `SelfMemberSheet.tsx`
- Modify: `apps/mobile/src/features/band/MemberRow.tsx`

**Interfaces:**
- Produces:
  - `SheetRow({ title, subtitle?, trailing?, danger?, onPress })`
  - `MemberHeader({ name, subtitle })`
  - `MemberRow({ member, isMe, tappable, onPress })`
  - `PartSheet({ visible, onClose, current: string | null, onSubmit(part: string) })` — `onSubmit`은 이미 정규화된 값을 받는다.
  - `SelfMemberSheet({ visible, onClose, me: BandMember, isOwner, onChangePart, onTransfer })`

- [ ] **Step 1: SheetRow·MemberHeader**

`apps/mobile/src/features/band/SheetRow.tsx`:

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

/** 디자인의 시트 행: 좌측 제목(+부제), 우측 값. danger는 빨간 제목. */
export function SheetRow({
  title,
  subtitle,
  trailing,
  danger = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  danger?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderRadius: radius.row,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontSize: 15, color: danger ? colors.danger : colors.text }}>{title}</AppText>
        {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
      </View>
      {trailing ?? null}
    </PressableOpacity>
  );
}
```

`apps/mobile/src/features/band/MemberHeader.tsx`:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar } from "@/ui";

/** 시트 상단: 아바타 · 이름 · 부제(역할 또는 파트). 아래 구분선. */
export function MemberHeader({ name, subtitle }: { name: string; subtitle: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingHorizontal: 8,
        paddingTop: 2,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={name[0] ?? "?"} size={44} />
      <View>
        <AppText variant="rowTitle">{name}</AppText>
        <AppText variant="caption" style={{ marginTop: 2 }}>
          {subtitle}
        </AppText>
      </View>
    </View>
  );
}
```

- [ ] **Step 2: MemberRow 교체**

`apps/mobile/src/features/band/MemberRow.tsx` 전체:

```tsx
import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, Avatar, MonoLabel, PressableOpacity } from "@/ui";
import { partLabel } from "./partValue";

/** 멤버 행: 이름(본인은 "(You)"), 파트, OWNER 배지, 탭 가능하면 chevron. */
export function MemberRow({
  member,
  isMe,
  tappable,
  onPress,
}: {
  member: BandMember;
  isMe: boolean;
  tappable: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!tappable}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={member.name[0] ?? "?"} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ fontSize: 15, color: colors.text }}>
          {isMe ? `${member.name} ${t("common.you")}` : member.name}
        </AppText>
        <AppText variant="small" style={{ marginTop: 3, color: colors.textMuted }}>
          {partLabel(member.part, t)}
        </AppText>
      </View>
      {member.role === "owner" ? (
        <MonoLabel
          color={colors.textMuted}
          style={{
            fontSize: 10,
            letterSpacing: 1.2,
            borderWidth: 1,
            borderColor: colors.borderStronger,
            borderRadius: radius.chipSm,
            paddingVertical: 3,
            paddingHorizontal: 8,
          }}
        >
          {t("band.role.owner").toUpperCase()}
        </MonoLabel>
      ) : null}
      {tappable ? <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText> : null}
    </PressableOpacity>
  );
}
```

디자인의 배지는 `OWNER` 고정 영문이다 — `band.role.owner`를 대문자로 쓰면 en에서는 `OWNER`, ko에서는 `관리자`가 된다. 의도한 동작이다.

- [ ] **Step 3: PartSheet**

`apps/mobile/src/features/band/PartSheet.tsx`:

```tsx
import { BAND_PART_PRESETS } from "@bandapp/types";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";
import { normalizePartInput } from "./partValue";
import { SheetRow } from "./SheetRow";

/** 프리셋 5개 + 직접 입력. onSubmit은 정규화된 값(프리셋 키 또는 trim된 자유 문자열)만 받는다. */
export function PartSheet({
  visible,
  onClose,
  current,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  current: string | null;
  onSubmit: (part: string) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  useEffect(() => {
    if (visible) setInput("");
  }, [visible]);

  const submitCustom = () => {
    const value = normalizePartInput(input, t);
    if (value === null) return; // 빈 입력은 무시
    onSubmit(value);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.part.title")} subtitle={t("band.part.subtitle")}>
      {BAND_PART_PRESETS.map((key) => (
        <SheetRow
          key={key}
          title={t(`band.part.preset.${key}`)}
          onPress={() => onSubmit(key)}
          trailing={current === key ? <AppText style={{ color: colors.accent, fontSize: 16 }}>✓</AppText> : null}
        />
      ))}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 10, paddingHorizontal: 4 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submitCustom}
          placeholder={t("band.part.placeholder")}
          placeholderTextColor={colors.textFaint}
          returnKeyType="done"
          style={{
            flex: 1,
            backgroundColor: colors.surfaceSunken,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            borderRadius: radius.input,
            paddingVertical: 11,
            paddingHorizontal: 14,
            color: colors.text,
            fontSize: 14,
          }}
        />
        <PressableOpacity
          onPress={submitCustom}
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppText style={{ color: colors.bg, fontSize: 16 }}>✓</AppText>
        </PressableOpacity>
      </View>
    </BottomSheet>
  );
}
```

- [ ] **Step 4: SelfMemberSheet**

`apps/mobile/src/features/band/SelfMemberSheet.tsx`:

```tsx
import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { AppText, BottomSheet } from "@/ui";
import { useTheme } from "@/theme";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/** 본인 행을 눌렀을 때. 파트 변경, owner면 소유권 이전. */
export function SelfMemberSheet({
  visible,
  onClose,
  me,
  isOwner,
  onChangePart,
  onTransfer,
}: {
  visible: boolean;
  onClose: () => void;
  me: BandMember;
  isOwner: boolean;
  onChangePart: () => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <MemberHeader name={me.name} subtitle={t(isOwner ? "band.role.owner" : "band.role.member")} />
      <SheetRow
        title={t("band.self.changePart")}
        onPress={onChangePart}
        trailing={<AppText style={{ fontSize: 14, color: colors.textMuted }}>{partLabel(me.part, t)}</AppText>}
      />
      {isOwner ? (
        <SheetRow title={t("band.self.transfer")} subtitle={t("band.self.transferSubtitle")} onPress={onTransfer} />
      ) : null}
    </BottomSheet>
  );
}
```

- [ ] **Step 5: 타입체크**

Run: `pnpm --filter mobile typecheck`
Expected: `BandScreen`이 아직 옛 `MemberRow` 시그니처(`{ member }`만)를 쓰므로 그 한 곳에서 오류. 임시로 `BandScreen`의 `renderItem`을 `({ item }) => <MemberRow member={item} isMe={false} tappable={false} onPress={() => undefined} />`로 바꿔 통과시킨다 (Task 6에서 교체).

- [ ] **Step 6: 커밋**

```bash
git add apps/mobile/src/features/band
git commit -m "feat(mobile): add member row with parts, part picker sheet, and self member sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: MemberSheet · TransferSheet · RenameSheet · InviteSheet i18n

**Files:**
- Create: `apps/mobile/src/features/band/MemberSheet.tsx`, `TransferSheet.tsx`, `RenameSheet.tsx`
- Modify: `apps/mobile/src/features/band/InviteSheet.tsx`

**Interfaces:**
- Produces:
  - `MemberSheet({ visible, onClose, member: BandMember | null, onMakeOwner, onRemove })`
  - `TransferSheet({ visible, onClose, candidates: BandMember[], onPick(member) })`
  - `RenameSheet({ visible, onClose, initial: string, onSave(name: string) })` — `onSave`는 trim된 비어 있지 않은 값만.

- [ ] **Step 1: MemberSheet**

`apps/mobile/src/features/band/MemberSheet.tsx`:

```tsx
import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/ui";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/** owner가 다른 멤버를 눌렀을 때. member가 null이면 닫힌 상태로 취급한다. */
export function MemberSheet({
  visible,
  onClose,
  member,
  onMakeOwner,
  onRemove,
}: {
  visible: boolean;
  onClose: () => void;
  member: BandMember | null;
  onMakeOwner: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <BottomSheet visible={visible && member !== null} onClose={onClose}>
      {member ? (
        <>
          <MemberHeader name={member.name} subtitle={partLabel(member.part, t)} />
          <SheetRow title={t("band.member.makeOwner")} subtitle={t("band.member.makeOwnerSubtitle")} onPress={onMakeOwner} />
          <SheetRow title={t("band.member.remove")} danger onPress={onRemove} />
        </>
      ) : null}
    </BottomSheet>
  );
}
```

- [ ] **Step 2: TransferSheet**

`apps/mobile/src/features/band/TransferSheet.tsx`:

```tsx
import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, PressableOpacity } from "@/ui";
import { partLabel } from "./partValue";

/** 본인을 제외한 멤버 중 새 owner를 고른다. 선택 → 확인 다이얼로그는 호출자가 띄운다. */
export function TransferSheet({
  visible,
  onClose,
  candidates,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  candidates: BandMember[];
  onPick: (member: BandMember) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.transfer.title")} subtitle={t("band.transfer.subtitle")}>
      {candidates.map((m) => (
        <PressableOpacity
          key={m.id}
          onPress={() => onPick(m)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: radius.row }}
        >
          <Avatar label={m.name[0] ?? "?"} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 15, color: colors.text }}>{m.name}</AppText>
            <AppText variant="small" style={{ marginTop: 2, color: colors.textMuted }}>
              {partLabel(m.part, t)}
            </AppText>
          </View>
          <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText>
        </PressableOpacity>
      ))}
    </BottomSheet>
  );
}
```

- [ ] **Step 3: RenameSheet**

`apps/mobile/src/features/band/RenameSheet.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextInput } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";

/** 이름 입력. trim 후 빈 값이면 무시. 길이 제한(50)은 서버 400 → 토스트. */
export function RenameSheet({
  visible,
  onClose,
  initial,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  initial: string;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);

  const save = () => {
    const name = value.trim();
    if (name.length === 0) return;
    onSave(name);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.rename.title")}>
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={save}
        autoFocus
        returnKeyType="done"
        style={{
          marginTop: 2,
          marginHorizontal: 4,
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.input,
          paddingVertical: 12,
          paddingHorizontal: 14,
          color: colors.text,
          fontSize: 15,
        }}
      />
      <PressableOpacity
        onPress={save}
        style={{
          marginTop: 12,
          marginHorizontal: 4,
          backgroundColor: colors.accent,
          borderRadius: radius.input,
          paddingVertical: 13,
          alignItems: "center",
        }}
      >
        <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{t("common.save")}</AppText>
      </PressableOpacity>
    </BottomSheet>
  );
}
```

- [ ] **Step 4: InviteSheet 문구 i18n**

`apps/mobile/src/features/band/InviteSheet.tsx`에서:
- `import { useTranslation } from "react-i18next";` 추가, 컴포넌트 안에 `const { t } = useTranslation();`
- `title="Invite your band"` → `title={t("band.invite.title")}`
- `subtitle="Send a link to invite members."` → `subtitle={t("band.invite.subtitle")}`
- `{copied ? "Copied" : "Copy link"}` → `{copied ? t("band.invite.copied") : t("band.invite.copy")}`

- [ ] **Step 5: 타입체크**

Run: `pnpm --filter mobile typecheck`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add apps/mobile/src/features/band
git commit -m "feat(mobile): add member, transfer, and rename sheets; localize invite sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: useBandActions와 BandScreen

**Files:**
- Create: `apps/mobile/src/features/band/useBandActions.ts`
- Modify: `apps/mobile/src/features/band/BandScreen.tsx` (전체 교체)

**Interfaces:**
- Produces:
  ```ts
  function useBandActions(band: Band | null, reloadMembers: () => void): {
    busy: boolean;
    setPart(part: string): Promise<void>;
    rename(name: string): Promise<void>;
    transfer(member: BandMember): Promise<void>;
    remove(member: BandMember): Promise<void>;
    leave(): Promise<"left" | "ownerMustTransfer" | "failed">;
    deleteBand(): Promise<void>;
  }
  ```
- Consumes: Task 2의 `apiErrorMessage`·`partLabel`, Task 3~5의 컴포넌트, `useCurrentBand().refreshBands`, `useAuth().state`.

- [ ] **Step 1: useBandActions**

`apps/mobile/src/features/band/useBandActions.ts`:

```ts
import { ApiError } from "@bandapp/api-client";
import type { Band, BandMember } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { useToast } from "@/ui";
import { partLabel } from "./partValue";
import { useCurrentBand } from "./useCurrentBand";

/**
 * 밴드 관리 액션. 성공하면 멤버 reload + 밴드 목록 refresh + 토스트, 실패하면 오류를 번역해 토스트.
 * 나가기·삭제 뒤에는 세션 탭으로 — 밴드가 0개면 bandGate가 온보딩으로 보낸다.
 * busy 동안 호출은 무시된다(두 번 누름 방지).
 */
export function useBandActions(band: Band | null, reloadMembers: () => void) {
  const api = useApi();
  const { t } = useTranslation();
  const toast = useToast();
  const router = useRouter();
  const { refreshBands } = useCurrentBand();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (busy || !band) return undefined;
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        toast.show(apiErrorMessage(err, t));
        if (err instanceof ApiError && err.code === "band_forbidden") await refreshBands();
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, band, toast, t, refreshBands],
  );

  const afterChange = useCallback(async () => {
    reloadMembers();
    await refreshBands();
  }, [reloadMembers, refreshBands]);

  const leaveBand = useCallback(async () => {
    await refreshBands();
    router.replace("/");
  }, [refreshBands, router]);

  return {
    busy,
    setPart: async (part: string) => {
      await run(async () => {
        await api.bands.setMyPart(band!.id, part);
        await afterChange();
        toast.show(t("band.toast.partSet", { part: partLabel(part, t) }));
      });
    },
    rename: async (name: string) => {
      await run(async () => {
        await api.bands.rename(band!.id, name);
        await afterChange();
        toast.show(t("band.toast.renamed"));
      });
    },
    transfer: async (member: BandMember) => {
      await run(async () => {
        await api.bands.transferOwnership(band!.id, member.id);
        await afterChange();
        toast.show(t("band.toast.transferred", { name: member.name }));
      });
    },
    remove: async (member: BandMember) => {
      await run(async () => {
        await api.bands.removeMember(band!.id, member.id);
        await afterChange();
        toast.show(t("band.toast.removed", { name: member.name }));
      });
    },
    leave: async (): Promise<"left" | "ownerMustTransfer" | "failed"> => {
      if (busy || !band) return "failed";
      setBusy(true);
      const name = band.name;
      try {
        await api.bands.leave(band.id);
        toast.show(t("band.toast.left", { band: name }));
        await leaveBand();
        return "left";
      } catch (err) {
        // 목록이 낡아 클라이언트가 owner인 줄 몰랐을 때 — 화면이 "먼저 이전" 다이얼로그를 띄운다
        if (err instanceof ApiError && err.code === "band_owner_must_transfer") return "ownerMustTransfer";
        toast.show(apiErrorMessage(err, t));
        return "failed";
      } finally {
        setBusy(false);
      }
    },
    deleteBand: async () => {
      await run(async () => {
        await api.bands.delete(band!.id);
        toast.show(t("band.toast.deleted"));
        await leaveBand();
      });
    },
  };
}
```

- [ ] **Step 2: BandScreen 교체**

`apps/mobile/src/features/band/BandScreen.tsx` 전체:

```tsx
import type { BandMember } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, View } from "react-native";
import { useApiData } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { radius, space, useTheme } from "@/theme";
import { AppText, ConfirmDialog, MonoLabel, PressableOpacity, Screen } from "@/ui";
import { InviteSheet } from "./InviteSheet";
import { MemberRow } from "./MemberRow";
import { MemberSheet } from "./MemberSheet";
import { PartSheet } from "./PartSheet";
import { RenameSheet } from "./RenameSheet";
import { SelfMemberSheet } from "./SelfMemberSheet";
import { TransferSheet } from "./TransferSheet";
import { useBandActions } from "./useBandActions";
import { useCurrentBand } from "./useCurrentBand";

type Sheet =
  | { kind: "self" }
  | { kind: "member"; member: BandMember }
  | { kind: "part" }
  | { kind: "transfer" }
  | { kind: "rename" }
  | { kind: "invite" }
  | null;

type Confirm =
  | { kind: "remove"; member: BandMember }
  | { kind: "transfer"; member: BandMember }
  | { kind: "delete" }
  | { kind: "leave" }
  | { kind: "ownerLeave" }
  | null;

export function BandScreen() {
  const { band } = useCurrentBand();
  const { state } = useAuth();
  const myId = state.status === "authenticated" ? state.user.id : null;
  const { data: members, reload } = useApiData(
    async (api) => (band ? api.bands.members(band.id) : []),
    [band?.id],
  );
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const actions = useBandActions(band, reload);

  const list = members ?? [];
  const me = list.find((m) => m.id === myId) ?? null;
  // 목록을 아직 못 불러왔으면 member로 취급 — owner 전용 UI가 깜빡이며 나타나는 것보다 안전하다
  const isOwner = me?.role === "owner";
  const bandName = band?.name ?? "";
  const others = list.filter((m) => m.id !== myId);

  const close = () => setSheet(null);

  const onLeavePress = () => setConfirm({ kind: isOwner ? "ownerLeave" : "leave" });

  const confirmProps = (() => {
    if (!confirm) return null;
    const cancel = () => setConfirm(null);
    switch (confirm.kind) {
      case "remove":
        return {
          title: t("band.confirm.remove.title", { name: confirm.member.name }),
          body: t("band.confirm.remove.body", { band: bandName }),
          primary: {
            label: t("band.confirm.remove.primary"),
            danger: true,
            onPress: () => void actions.remove(confirm.member).then(cancel),
          },
        };
      case "transfer":
        return {
          title: t("band.confirm.transfer.title", { name: confirm.member.name }),
          body: t("band.confirm.transfer.body"),
          primary: {
            label: t("band.confirm.transfer.primary"),
            onPress: () => void actions.transfer(confirm.member).then(cancel),
          },
        };
      case "delete":
        return {
          title: t("band.confirm.delete.title", { band: bandName }),
          body: t("band.confirm.delete.body"),
          primary: {
            label: t("band.confirm.delete.primary"),
            danger: true,
            onPress: () => void actions.deleteBand().then(cancel),
          },
        };
      case "leave":
        return {
          title: t("band.confirm.leave.title", { band: bandName }),
          body: t("band.confirm.leave.body"),
          primary: {
            label: t("band.confirm.leave.primary"),
            danger: true,
            onPress: () =>
              void actions.leave().then((result) => {
                if (result === "ownerMustTransfer") setConfirm({ kind: "ownerLeave" });
                else cancel();
              }),
          },
        };
      case "ownerLeave":
        return {
          title: t("band.confirm.ownerLeave.title"),
          body: t("band.confirm.ownerLeave.body", { band: bandName }),
          primary: {
            label: t("band.confirm.ownerLeave.primary"),
            onPress: () => {
              setConfirm(null);
              setSheet({ kind: "transfer" });
            },
          },
          secondary: {
            label: t("band.confirm.ownerLeave.secondary"),
            onPress: () => setConfirm({ kind: "delete" }),
          },
        };
    }
  })();

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <MonoLabel color={colors.textMuted} style={{ letterSpacing: 1.8 }}>
            {t("band.header.yourBand")}
          </MonoLabel>
          <PressableOpacity onPress={() => router.push("/settings")} style={{ padding: 4 }}>
            <AppText style={{ fontSize: 16, color: colors.textMuted }}>⚙</AppText>
          </PressableOpacity>
        </View>
        <AppText variant="titleXL">{bandName}</AppText>
        <MonoLabel>{t("band.header.members", { n: band?.memberCount ?? 0 })}</MonoLabel>
      </View>
      <FlatList
        data={list}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderItem={({ item }) => {
          const isMe = item.id === myId;
          const tappable = isMe || isOwner;
          return (
            <MemberRow
              member={item}
              isMe={isMe}
              tappable={tappable}
              onPress={() => setSheet(isMe ? { kind: "self" } : { kind: "member", member: item })}
            />
          );
        }}
        ListFooterComponent={
          <View>
            {isOwner ? (
              <PressableOpacity
                onPress={() => setSheet({ kind: "invite" })}
                style={{
                  marginTop: 20,
                  borderWidth: 1,
                  borderColor: colors.borderStrong,
                  borderRadius: radius.input,
                  padding: 14,
                  alignItems: "center",
                }}
              >
                <AppText style={{ fontSize: 14, color: colors.accent }}>{t("band.invite.button")}</AppText>
              </PressableOpacity>
            ) : null}
            <MonoLabel style={{ paddingTop: 32, paddingBottom: 4, letterSpacing: 1.6 }}>{t("band.manage.title")}</MonoLabel>
            {isOwner ? (
              <ManageRow
                title={t("band.manage.bandName")}
                value={bandName}
                onPress={() => setSheet({ kind: "rename" })}
              />
            ) : null}
            {isOwner ? (
              <ManageRow title={t("band.manage.transfer")} onPress={() => setSheet({ kind: "transfer" })} />
            ) : null}
            <ManageRow title={t("band.manage.leave")} danger onPress={onLeavePress} />
            {isOwner ? (
              <ManageRow title={t("band.manage.delete")} danger last onPress={() => setConfirm({ kind: "delete" })} />
            ) : null}
          </View>
        }
      />

      {band ? <InviteSheet visible={sheet?.kind === "invite"} onClose={close} bandId={band.id} /> : null}
      {me ? (
        <SelfMemberSheet
          visible={sheet?.kind === "self"}
          onClose={close}
          me={me}
          isOwner={isOwner}
          onChangePart={() => setSheet({ kind: "part" })}
          onTransfer={() => setSheet({ kind: "transfer" })}
        />
      ) : null}
      <PartSheet
        visible={sheet?.kind === "part"}
        onClose={close}
        current={me?.part ?? null}
        onSubmit={(part) => {
          close();
          void actions.setPart(part);
        }}
      />
      <MemberSheet
        visible={sheet?.kind === "member"}
        onClose={close}
        member={sheet?.kind === "member" ? sheet.member : null}
        onMakeOwner={() => {
          if (sheet?.kind !== "member") return;
          const { member } = sheet;
          close();
          setConfirm({ kind: "transfer", member });
        }}
        onRemove={() => {
          if (sheet?.kind !== "member") return;
          const { member } = sheet;
          close();
          setConfirm({ kind: "remove", member });
        }}
      />
      <TransferSheet
        visible={sheet?.kind === "transfer"}
        onClose={close}
        candidates={others}
        onPick={(member) => {
          close();
          setConfirm({ kind: "transfer", member });
        }}
      />
      <RenameSheet
        visible={sheet?.kind === "rename"}
        onClose={close}
        initial={bandName}
        onSave={(name) => {
          close();
          void actions.rename(name);
        }}
      />
      {confirmProps ? (
        <ConfirmDialog
          visible
          title={confirmProps.title}
          body={confirmProps.body}
          primary={confirmProps.primary}
          secondary={"secondary" in confirmProps ? confirmProps.secondary : undefined}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirm(null)}
          busy={actions.busy}
        />
      ) : null}
    </Screen>
  );
}

/** MANAGE 섹션의 행. 디자인: 16px 세로 패딩, 아래 구분선, 우측 값 + chevron. */
function ManageRow({
  title,
  value,
  danger = false,
  last = false,
  onPress,
}: {
  title: string;
  value?: string;
  danger?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppText style={{ fontSize: 15, color: danger ? colors.danger : colors.text }}>{title}</AppText>
      {danger ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {value ? <AppText style={{ fontSize: 14, color: colors.textMuted }}>{value}</AppText> : null}
          <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText>
        </View>
      )}
    </PressableOpacity>
  );
}
```

- [ ] **Step 3: 타입체크·테스트**

Run: `pnpm --filter mobile typecheck && pnpm --filter mobile test`
Expected: 통과. `ConfirmDialog`의 `visible` prop이 boolean 리터럴 `true`인 것은 의도다 — `confirmProps`가 null이면 렌더하지 않는다.

- [ ] **Step 4: 커밋**

```bash
git add apps/mobile/src/features/band
git commit -m "feat(mobile): wire the band screen to part, member, transfer, rename, leave, and delete actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 웹 프리뷰 검증

**Files:** 없음 (검증만). 문제가 나오면 해당 태스크의 파일을 고치고 같은 커밋 규칙으로 커밋한다.

- [ ] **Step 1: Mock 웹 프리뷰 기동**

Browser pane의 `preview_start`에 `{ name: "mobile-web-mock" }` (`.claude/launch.json`에 이미 있다). `EXPO_PUBLIC_API_URL`이 비어 Mock으로 뜬다. 로그인 화면이 나오면 Google 버튼(Mock은 즉시 통과) → 세션 탭 → 하단 `BAND` 탭.

- [ ] **Step 2: owner 상태 (b1 FRIDAY NIGHT)**

확인 항목 — 각각 `read_page`로 텍스트를, 마지막에 `screenshot`으로 증거를 남긴다:
1. 멤버 4명. `Dongjin (You)` 행에 `Guitar`·`OWNER` 배지·chevron. `Jihoon` 행은 `Synth`(자유 문자열 그대로). `Suhyun`은 `No part set`.
2. `+ Invite member` 보임. MANAGE에 `Band name FRIDAY NIGHT ›`, `Transfer ownership`, `Leave band`, `Delete band`.
3. 본인 행 탭 → 시트에 `Owner`, `Change part Guitar`, `Transfer ownership`. `Change part` → 프리셋 5개 중 `Guitar`에 ✓. `Bass` 탭 → 토스트 `Part set to Bass`, 행이 `Bass`.
4. 다시 파트 시트 → 입력에 `keys` 치고 ✓ → 행이 `Keys`(키로 정규화됨). 입력에 `Sax` → 행이 `Sax`.
5. `Minsu` 행 탭 → `Make owner`, `Remove from band`. `Remove from band` → 다이얼로그 `Remove Minsu?` 빨간 주 버튼 → `Remove` → 토스트, 멤버 3명, `MEMBERS · 3`.
6. `Leave band` → `Transfer ownership first` 다이얼로그(주: Transfer ownership, 보조: Delete band 빨간 텍스트). 주 버튼 → 이전 시트에 `Jihoon`, `Suhyun`(본인 제외). `Jihoon` → `Make Jihoon the owner?` accent 주 버튼 → 확인 → 토스트, `Jihoon` 행에 OWNER 배지, 본인 행에서 배지 사라짐, `+ Invite member`·`Band name`·`Transfer ownership`·`Delete band` 사라짐.
7. 이제 member 상태에서 `Leave band` → `Leave FRIDAY NIGHT?` → 확인 → 세션 탭으로 이동, 밴드 스위처에 `SIDE PROJECT`만.

- [ ] **Step 3: member 상태 (b2 SIDE PROJECT)**

페이지 새로고침(Mock 상태 초기화) 후 세션 탭의 밴드 스위처로 `SIDE PROJECT` 선택 → BAND 탭:
1. `Minsu`에 OWNER 배지, chevron 없음. 본인 행만 chevron.
2. `+ Invite member` 없음. MANAGE에 `Leave band`만.
3. `Delete band`·`Band name`·`Transfer ownership` 없음.

- [ ] **Step 4: 콘솔 확인**

`read_console_messages`에 오류가 없어야 한다. i18next의 `missingKey` 경고가 있으면 키 오타다 — 리소스나 호출부를 고친다.

- [ ] **Step 5: 한국어 확인**

웹 번들에서는 i18next 인스턴스에 밖에서 손댈 수 없으므로 **임시로** `src/i18n/index.ts`의 `lng: deviceLanguage()`를 `lng: "ko"`로 바꾸고 새로고침한다. 화면 문구가 한국어인지(`+ 팀원 초대`, `밴드 나가기`, 파트 `기타`, 본인 행 `(나)`) 확인한 뒤 원복한다. 이 임시 변경은 커밋하지 않는다 — 끝나면 `git diff --stat`이 비어 있어야 한다.

- [ ] **Step 6: 기기 검증 안내를 README에**

`README.md`의 "### 녹음 업로드·분석 (모바일)" 절 아래에 절을 추가:

```
### 팀 관리·i18n (모바일)

- 밴드 탭에서 파트 변경(프리셋 + 직접 입력), owner의 팀원 내보내기·소유권 이전, 이름 변경, 나가기, 삭제가 된다. 서버 API는 `PATCH /bands/:id`, `POST /bands/:id/transfer`, `DELETE /bands/:id`(soft delete).
- 문구는 `apps/mobile/src/i18n`의 ko/en 리소스에서 온다. 기기 언어가 ko면 한국어, 아니면 영어. 아직 이 화면만 리소스를 쓴다 (나머지 화면은 백로그).
- `expo-localization`이 새로 들어갔으니 dev build를 다시 만들어야 한다: `pnpm --filter mobile ios` (맥).
```

- [ ] **Step 7: 커밋**

```bash
git add README.md
git commit -m "docs: describe band management and mobile i18n

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 자체 검토

- **스펙 커버리지:** i18n 인프라·키(Task 1), `apiErrorMessage`·`partValue`(Task 2), `ConfirmDialog`(Task 3), 시트 5개·`MemberRow`·`InviteSheet`(Task 4·5), `BandScreen` 상태·owner 판정·탭 조건·MANAGE 가시성·액션 후 처리·403 시 refresh·ownerLeave 409 폴백(Task 6), Mock 두 상태 검증(Task 7). `errors.invite_*` 키는 Task 1에 미리 들어간다.
- **타입 일관성:** `partLabel(part, t)`·`normalizePartInput(input, t)`(Task 2) ↔ 사용처(Task 4·5·6). `useBandActions(band, reload)`가 돌려주는 이름 `setPart/rename/transfer/remove/leave/deleteBand`(Task 6). `ConfirmDialog` props `primary.danger`, `secondary`, `cancelLabel`, `busy`(Task 3 ↔ 6). `MemberRow` props `member/isMe/tappable/onPress`(Task 4 ↔ 6). Mock 시드 id `u-mock`은 `auth.me()`의 `MOCK_USER.id`와 같다 — 서버 플랜 Task 6에서 맞춘다.
- **플레이스홀더:** 없음. "기존 그대로"로 표시한 곳은 서버 플랜 Task 6의 `createInvite`·`revokeInvite`뿐이며 그 파일의 현재 코드를 뜻한다.

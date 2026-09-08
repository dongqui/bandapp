import type { Resource } from "./types";

/** 어투는 설정 화면·서버 메시지와 같은 "~해요". 키가 빠지면 타입체크가 잡는다. */
export const ko: Resource = {
  common: {
    cancel: "취소",
    save: "저장",
    you: "(나)",
  },
  band: {
    // YOUR BAND / MEMBERS / MANAGE는 디자인의 모노 라벨 chrome이라 의도적으로 영어를 유지한다
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

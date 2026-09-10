/**
 * 지금 이 앱 프로세스에서 실제로 진행 중인 업로드/이어 올리기 세션 id의 메모리 집합
 * (2026-09-10 업로드 재개 스펙 리뷰 후속 — finding A: 화면을 벗어나도 업로드 프라미스는 계속
 * 돌아간다). pending.json 레코드는 create가 끝나면 바로 디스크에 남아 화면을 나가도 사라지지
 * 않지만, 실제 네트워크 요청(파트 PUT)은 화면이 언마운트돼도 그대로 진행된다. 레코드만 보고
 * "이어 올릴 수 있음"이라 표시하면 같은 세션을 두 번(원래 요청 + 재개 요청) 업로드하게 된다.
 *
 * 일부러 메모리에만 둔다: 앱이 강제 종료되면 이 집합은 비워지는데, 그게 바로 재개를 제안해야
 * 하는 순간이다 — 프로세스가 죽었으니 실제로 진행 중인 요청은 더 이상 없다.
 *
 * react-native를 import하지 않는다 — 순수 vitest에서 스토어·훅과 함께 검증할 수 있어야 한다.
 */
export interface InFlightUploads {
  add(sessionId: string): void;
  delete(sessionId: string): void;
  has(sessionId: string): boolean;
}

export function createInFlightUploads(): InFlightUploads {
  const ids = new Set<string>();
  return {
    add(sessionId) {
      ids.add(sessionId);
    },
    delete(sessionId) {
      ids.delete(sessionId);
    },
    has(sessionId) {
      return ids.has(sessionId);
    },
  };
}

export const inFlightUploads = createInFlightUploads();

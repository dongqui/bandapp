const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 초대 링크/딥링크/생 토큰 어느 형태든 토큰만 뽑는다. 수동 복구 경로(기획서 14장)에서도 사용. */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (TOKEN_RE.test(trimmed)) return trimmed;
  const match = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(trimmed);
  return match?.[1] ?? null;
}

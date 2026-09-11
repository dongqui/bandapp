/** expo-audio status 하나가 anchor다. seq는 새 status가 왔음을 UI 스레드에 알리는 카운터 */
export interface PlayheadAnchor {
  seq: number;
  posMs: number;
  playing: boolean;
}

/** anchor 이후 이만큼까지만 앞으로 보간한다 — status가 멈추면(버퍼링·인터럽션) playhead도 멈춘다 (스펙 결정 9) */
export const MAX_EXTRAPOLATION_MS = 400;

/** anchor 이후 elapsedMs만큼 흘렀을 때의 표시 위치 */
export function interpolatePlayhead(anchor: PlayheadAnchor, elapsedMs: number): number {
  "worklet";
  if (!anchor.playing) return anchor.posMs;
  return anchor.posMs + Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, elapsedMs));
}

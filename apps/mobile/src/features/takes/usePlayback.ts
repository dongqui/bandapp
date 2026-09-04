import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * url이 있으면 expo-audio로 실제 재생, 없으면(Mock 모드) 기존 시뮬레이션 타이머.
 * 두 경로의 반환 형태는 같아서 화면은 어느 쪽인지 모른다.
 */
export function usePlayback(durationSec: number, url: string | null) {
  // url이 바뀔 때만 새 소스 객체를 만든다 — 매 렌더마다 재생성되면 플레이어가 계속 재로딩된다.
  const source = useMemo(() => (url ? { uri: url } : null), [url]);
  const player = useAudioPlayer(source, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  const simulated = useSimulatedPlayback(durationSec, !url);

  if (!url) return simulated;

  const total = status.duration || durationSec;
  return {
    positionSec: status.currentTime,
    playing: status.playing,
    // 로드·디코딩 실패는 화면이 토스트로 알린다 — 안 그러면 재생 버튼이 먹통인 이유를 알 수 없다
    error: status.error ?? null,
    toggle: () => {
      if (status.playing) player.pause();
      else {
        if (status.didJustFinish || status.currentTime >= total) void player.seekTo(0);
        player.play();
      }
    },
    seekTo: (sec: number, autoplay = false) => {
      void player.seekTo(Math.max(0, Math.min(total, sec)));
      if (autoplay) player.play();
    },
  };
}

function useSimulatedPlayback(durationSec: number, enabled: boolean) {
  const [positionSec, setPositionSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(0);
  posRef.current = positionSec;

  useEffect(() => {
    if (!enabled || !playing) return;
    const t = setInterval(() => {
      const next = posRef.current + 0.2;
      if (next >= durationSec) {
        setPositionSec(durationSec);
        setPlaying(false);
      } else {
        setPositionSec(next);
      }
    }, 200);
    return () => clearInterval(t);
  }, [enabled, playing, durationSec]);

  const toggle = () => {
    setPlaying((p) => {
      if (!p && posRef.current >= durationSec) setPositionSec(0);
      return !p;
    });
  };
  const seekTo = (sec: number, autoplay = false) => {
    setPositionSec(Math.max(0, Math.min(durationSec, sec)));
    if (autoplay) setPlaying(true);
  };
  return { positionSec, playing, toggle, seekTo, error: null };
}

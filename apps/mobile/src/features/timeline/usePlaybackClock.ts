import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { interpolatePlayhead, type PlayheadAnchor } from "@/lib/timeline/playhead";

const STATUS_INTERVAL_MS = 200;

export interface PlaybackClock {
  /** UI 스레드에서 매 프레임 보간되는 표시 위치 (ms) */
  playheadMs: SharedValue<number>;
  playing: boolean;
  /** 클럭 라벨용 — status 간격(200ms)으로만 바뀐다 */
  positionMs: number;
  error: string | null;
  toggle: () => void;
  seekTo: (ms: number) => void;
}

/**
 * 재생 위치의 기준은 expo-audio status(200ms)다 (2026-09-11 스펙 결정 9). status가 anchor가 되고
 * useFrameCallback이 그 사이를 최대 400ms까지 보간한다. anchor를 본 프레임 시각(seenAt)에서부터 재니
 * JS·UI 스레드 시계가 달라도 상관없다. seek 중에는 도착하는 status를 무시하고 목표 위치에 고정한다.
 * url이 없으면(Mock) 200ms 타이머가 anchor를 흉내 낸다 — 기존 usePlayback의 시뮬레이션과 같은 역할.
 */
export function usePlaybackClock(url: string | null, durationMs: number): PlaybackClock {
  const source = useMemo(() => (url ? { uri: url } : null), [url]);
  const player = useAudioPlayer(source, { updateInterval: STATUS_INTERVAL_MS });
  const status = useAudioPlayerStatus(player);

  const anchor = useSharedValue<PlayheadAnchor>({ seq: 0, posMs: 0, playing: false });
  const seenSeq = useSharedValue(-1);
  const seenAt = useSharedValue(0);
  const playheadMs = useSharedValue(0);
  const seqRef = useRef(0);
  const seekPendingRef = useRef(false);
  /** 오디오가 로드되기 전에 들어온 seek (화면을 열자마자 첫 take로 가는 경우) — 로드되면 적용한다 */
  const deferredSeekRef = useRef<number | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [simPlaying, setSimPlaying] = useState(false);
  const simPosRef = useRef(0);

  const setAnchor = useCallback(
    (posMs: number, playing: boolean) => {
      seqRef.current += 1;
      anchor.value = { seq: seqRef.current, posMs, playing };
      setPositionMs(posMs);
    },
    [anchor],
  );

  // 실제 플레이어: status → anchor. seek 대기 중이면 옛 status가 playhead를 되돌리지 못하게 무시한다 (초안 22-D)
  useEffect(() => {
    if (!url || seekPendingRef.current || deferredSeekRef.current !== null) return;
    setAnchor(status.currentTime * 1000, status.playing && !status.isBuffering);
  }, [url, status.currentTime, status.playing, status.isBuffering, setAnchor]);

  // Mock: 200ms마다 anchor를 앞으로
  useEffect(() => {
    if (url || !simPlaying) return;
    const t = setInterval(() => {
      const next = simPosRef.current + STATUS_INTERVAL_MS;
      if (next >= durationMs) {
        simPosRef.current = durationMs;
        setSimPlaying(false);
        setAnchor(durationMs, false);
      } else {
        simPosRef.current = next;
        setAnchor(next, true);
      }
    }, STATUS_INTERVAL_MS);
    return () => clearInterval(t);
  }, [url, simPlaying, durationMs, setAnchor]);

  // 프레임마다: 새 anchor면 그 프레임 시각을 기억하고, 거기서 흐른 만큼 보간
  useFrameCallback((frame) => {
    const a = anchor.value;
    if (a.seq !== seenSeq.value) {
      seenSeq.value = a.seq;
      seenAt.value = frame.timestamp;
    }
    playheadMs.value = interpolatePlayhead(a, frame.timestamp - seenAt.value);
  });

  const totalMs = url ? (status.duration ? status.duration * 1000 : durationMs) : durationMs;
  const playing = url ? status.playing : simPlaying;

  const seekTo = useCallback(
    (ms: number) => {
      const target = Math.max(0, Math.min(totalMs, ms));
      if (!url) {
        // Mock이거나 URL을 아직 못 받았다 — 뒤의 경우 로드된 뒤 실제 플레이어에 다시 적용한다
        deferredSeekRef.current = target;
        simPosRef.current = target;
        setAnchor(target, simPlaying);
        return;
      }
      if (!status.isLoaded) {
        deferredSeekRef.current = target;
        setAnchor(target, false);
        return;
      }
      deferredSeekRef.current = null;
      seekPendingRef.current = true;
      setAnchor(target, false);
      void player.seekTo(target / 1000).finally(() => {
        seekPendingRef.current = false;
      });
    },
    [url, totalMs, simPlaying, status.isLoaded, player, setAnchor],
  );

  useEffect(() => {
    if (!url || !status.isLoaded || deferredSeekRef.current === null) return;
    seekTo(deferredSeekRef.current);
  }, [url, status.isLoaded, seekTo]);

  const toggle = useCallback(() => {
    if (!url) {
      if (simPlaying) {
        setAnchor(simPosRef.current, false);
        setSimPlaying(false);
        return;
      }
      if (simPosRef.current >= durationMs) simPosRef.current = 0;
      setAnchor(simPosRef.current, true);
      setSimPlaying(true);
      return;
    }
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || status.currentTime * 1000 >= totalMs) void player.seekTo(0);
    player.play();
  }, [url, simPlaying, durationMs, status.playing, status.didJustFinish, status.currentTime, totalMs, player, setAnchor]);

  return { playheadMs, playing, positionMs, error: url ? (status.error ?? null) : null, toggle, seekTo };
}

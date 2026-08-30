import { useEffect, useRef, useState } from "react";

export function usePlayback(durationSec: number) {
  const [positionSec, setPositionSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(0);
  posRef.current = positionSec;

  useEffect(() => {
    if (!playing) return;
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
  }, [playing, durationSec]);

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
  return { positionSec, playing, toggle, seekTo };
}

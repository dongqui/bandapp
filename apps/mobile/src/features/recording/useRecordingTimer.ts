import { useEffect, useState } from "react";

export function useRecordingTimer() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSeconds((Date.now() - started) / 1000), 200);
    return () => clearInterval(t);
  }, []);
  return { seconds };
}

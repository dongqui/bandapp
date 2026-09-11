import type { Take } from "@bandapp/types";
import { useEffect } from "react";

const POLL_MS = 3000;

/** 재컷 중(updating)인 take가 하나라도 있으면 3초마다 목록을 다시 읽는다 (스펙 B §상태 전파). 없어지면 멈춘다 */
export function useTakesPolling(takes: Take[] | undefined, reload: () => void): void {
  const updating = (takes ?? []).some((t) => t.audioStatus === "updating");
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [updating, reload]);
}

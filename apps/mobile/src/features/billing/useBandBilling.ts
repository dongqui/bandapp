import type { BandBilling } from "@bandapp/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/api";

/** useApiData와 같은 구독 갱신 패턴이지만 실패를 노출한다 — B01의 "Couldn't load your plan" + Retry 때문 */
export function useBandBilling(bandId: string | undefined) {
  const api = useApi();
  const [data, setData] = useState<BandBilling | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const reqRef = useRef(0);
  const reload = useCallback(() => {
    if (!bandId) return;
    const id = ++reqRef.current;
    setFailed(false);
    api.bands
      .billing(bandId)
      .then((b) => { if (reqRef.current === id) setData(b); })
      .catch(() => { if (reqRef.current === id) setFailed(true); });
  }, [api, bandId]);
  useEffect(() => {
    reload();
    const off = api.subscribe(reload);
    return () => { reqRef.current++; off(); };
  }, [api, reload]);
  return { data, failed, reload };
}

import type { RehearsalApiClient } from "@bandapp/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "./ApiProvider";

export function useApiData<T>(
  load: (api: RehearsalApiClient) => Promise<T>,
  deps: unknown[],
): { data: T | undefined; reload: () => void } {
  const api = useApi();
  const [data, setData] = useState<T | undefined>(undefined);
  const requestIdRef = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadCb = useCallback(load, deps);
  const reload = useCallback(() => {
    const id = ++requestIdRef.current;
    void loadCb(api)
      .then((d) => {
        if (requestIdRef.current === id) setData(d);
      })
      .catch((e) => {
        if (requestIdRef.current === id) console.warn("useApiData load failed", e);
      });
  }, [api, loadCb]);
  useEffect(() => {
    reload();
    const off = api.subscribe(() => reload());
    return () => {
      requestIdRef.current++; // cancel any in-flight request on unmount/dep change
      off();
    };
  }, [api, reload]);
  return { data, reload };
}

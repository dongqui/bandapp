import type { RehearsalApiClient } from "@bandapp/api-client";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "./ApiProvider";

export function useApiData<T>(
  load: (api: RehearsalApiClient) => Promise<T>,
  deps: unknown[],
): { data: T | undefined; reload: () => void } {
  const api = useApi();
  const [data, setData] = useState<T | undefined>(undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadCb = useCallback(load, deps);
  const reload = useCallback(() => {
    let cancelled = false;
    loadCb(api).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadCb]);
  useEffect(() => {
    const cancel = reload();
    const off = api.subscribe(() => reload());
    return () => {
      cancel();
      off();
    };
  }, [api, reload]);
  return { data, reload };
}

import { useApiData } from "@/api";

export function useCurrentBand() {
  const { data } = useApiData((api) => api.bands.list(), []);
  return { band: data?.[0] };
}

import { useCurrentBandContext } from "./CurrentBandProvider";

/** 마지막 선택 Band 유지(기획서 2장) — CurrentBandProvider Context로 위임. */
export function useCurrentBand() {
  return useCurrentBandContext();
}

import type { Band } from "@bandapp/types";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi, useApiData } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { secureStorage } from "@/services/secure-storage";

interface CurrentBandValue {
  band: Band | null;
  bands: Band[];
  loading: boolean;
  setCurrentBand(bandId: string): void;
}

const CurrentBandContext = createContext<CurrentBandValue | null>(null);

export function CurrentBandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { state } = useAuth();
  const authed = state.status === "authenticated";
  const { data: bands } = useApiData(() => (authed ? api.bands.list() : Promise.resolve([])), [
    api,
    authed,
  ]);
  const [currentBandId, setCurrentBandId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    secureStorage.get("lastBandId").then((saved) => {
      setCurrentBandId(saved);
      setRestored(true);
    });
  }, []);

  function setCurrentBand(bandId: string): void {
    setCurrentBandId(bandId);
    void secureStorage.set("lastBandId", bandId);
  }

  // 마지막 밴드가 사라졌으면(탈퇴 등) 첫 밴드로
  const list = bands ?? [];
  const band = list.find((b) => b.id === currentBandId) ?? list[0] ?? null;

  return (
    <CurrentBandContext.Provider
      value={{ band, bands: list, loading: !restored || bands === undefined, setCurrentBand }}
    >
      {children}
    </CurrentBandContext.Provider>
  );
}

export function useCurrentBandContext(): CurrentBandValue {
  const value = useContext(CurrentBandContext);
  if (!value) throw new Error("useCurrentBandContext must be used within CurrentBandProvider");
  return value;
}

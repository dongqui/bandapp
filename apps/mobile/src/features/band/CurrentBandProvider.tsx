import type { Band } from "@bandapp/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { secureStorage } from "@/services/secure-storage";

interface CurrentBandValue {
  band: Band | null;
  bands: Band[];
  loading: boolean;
  setCurrentBand(bandId: string): void;
  /** 밴드 생성/참가 직후 리스트를 즉시 새로고침 — bandGate가 낡은 개수를 보고 온보딩으로 되돌리지 않도록 한다. */
  refreshBands(): Promise<void>;
}

const CurrentBandContext = createContext<CurrentBandValue | null>(null);

export function CurrentBandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { state } = useAuth();
  const authed = state.status === "authenticated";
  // null = 현재 인증 상태에서 아직 로드되지 않음(로딩 중). []는 로드 완료 + 0개.
  const [bands, setBands] = useState<Band[] | null>(null);
  const requestIdRef = useRef(0);
  const [currentBandId, setCurrentBandId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const loadBands = useCallback(async () => {
    const id = ++requestIdRef.current;
    try {
      const list = await api.bands.list();
      if (requestIdRef.current === id) setBands(list);
    } catch (err) {
      console.warn("band list load failed", err);
      if (requestIdRef.current === id) {
        // 이미 불러온 목록이 있으면 유지 — 일시적 네트워크 오류로 온보딩으로 튕기지 않게
        setBands((prev) => prev ?? []);
      }
    }
  }, [api]);

  useEffect(() => {
    if (!authed) {
      requestIdRef.current++; // 진행 중이던 요청 결과를 무시
      setBands([]);
      return;
    }
    setBands(null); // 인증 전환(guest -> authenticated 등) 시 로딩으로 리셋 — 이전 상태의 값을 들고 있지 않는다
    void loadBands();
    const off = api.subscribe(() => {
      void loadBands();
    });
    return () => {
      requestIdRef.current++; // 정리 시 진행 중인 요청 무효화
      off();
    };
  }, [api, authed, loadBands]);

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
      value={{
        band,
        bands: list,
        loading: !restored || bands === null,
        setCurrentBand,
        refreshBands: loadBands,
      }}
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

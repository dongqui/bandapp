import { ApiError } from "@bandapp/api-client";
import type { Band, BandMember } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { useToast } from "@/ui";
import { partLabel } from "./partValue";
import { useCurrentBand } from "./useCurrentBand";

/**
 * 밴드 관리 액션. 성공하면 멤버 reload + 밴드 목록 refresh + 토스트, 실패하면 오류를 번역해 토스트.
 * 나가기·삭제 뒤에는 세션 탭으로 — 밴드가 0개면 bandGate가 온보딩으로 보낸다.
 * busy 동안 호출은 무시된다(두 번 누름 방지).
 */
export function useBandActions(band: Band | null, reloadMembers: () => void) {
  const api = useApi();
  const { t } = useTranslation();
  const toast = useToast();
  const router = useRouter();
  const { refreshBands } = useCurrentBand();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (busy || !band) return undefined;
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        toast.show(apiErrorMessage(err, t));
        if (err instanceof ApiError && err.code === "band_forbidden") await refreshBands();
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, band, toast, t, refreshBands],
  );

  const afterChange = useCallback(async () => {
    reloadMembers();
    await refreshBands();
  }, [reloadMembers, refreshBands]);

  const leaveBand = useCallback(async () => {
    await refreshBands();
    router.replace("/");
  }, [refreshBands, router]);

  return {
    busy,
    setPart: async (part: string) => {
      await run(async () => {
        await api.bands.setMyPart(band!.id, part);
        await afterChange();
        toast.show(t("band.toast.partSet", { part: partLabel(part, t) }));
      });
    },
    rename: async (name: string) => {
      await run(async () => {
        await api.bands.rename(band!.id, name);
        await afterChange();
        toast.show(t("band.toast.renamed"));
      });
    },
    transfer: async (member: BandMember) => {
      await run(async () => {
        await api.bands.transferOwnership(band!.id, member.id);
        await afterChange();
        toast.show(t("band.toast.transferred", { name: member.name }));
      });
    },
    remove: async (member: BandMember) => {
      await run(async () => {
        await api.bands.removeMember(band!.id, member.id);
        await afterChange();
        toast.show(t("band.toast.removed", { name: member.name }));
      });
    },
    leave: async (): Promise<"left" | "ownerMustTransfer" | "failed"> => {
      if (busy || !band) return "failed";
      setBusy(true);
      const name = band.name;
      try {
        await api.bands.leave(band.id);
        toast.show(t("band.toast.left", { band: name }));
        await leaveBand();
        return "left";
      } catch (err) {
        // 목록이 낡아 클라이언트가 owner인 줄 몰랐을 때 — 화면이 "먼저 이전" 다이얼로그를 띄운다
        if (err instanceof ApiError && err.code === "band_owner_must_transfer") return "ownerMustTransfer";
        toast.show(apiErrorMessage(err, t));
        return "failed";
      } finally {
        setBusy(false);
      }
    },
    deleteBand: async () => {
      await run(async () => {
        await api.bands.delete(band!.id);
        toast.show(t("band.toast.deleted"));
        await leaveBand();
      });
    },
  };
}

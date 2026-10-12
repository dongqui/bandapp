import { useApiData } from "@/api";

/** 내 모든 밴드의 알림 설정 — Me 행 요약과 설정 화면이 같이 쓴다 */
export function useNotificationSettings() {
  return useApiData(async (api) => api.notifications.settings(), []);
}

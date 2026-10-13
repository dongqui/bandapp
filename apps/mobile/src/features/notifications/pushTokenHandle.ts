/**
 * AuthProvider → NotificationsProvider 방향의 최소 브리지 (session-events와 같은 패턴).
 * 로그아웃·탈퇴 직전에 푸시 토큰을 서버에서 지운다. 모듈 객체라서 import 순환이 생기지 않는다
 */
export const pushTokenHandle: { current: () => Promise<void> } = { current: async () => undefined };

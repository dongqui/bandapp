// HttpApiClient(생성 시점)와 AuthProvider(마운트 후)를 잇는 최소 이벤트 브리지
type Handler = () => void;
let handler: Handler | null = null;

export const sessionEvents = {
  setHandler(next: Handler | null): void {
    handler = next;
  },
  emitExpired(): void {
    handler?.();
  },
};

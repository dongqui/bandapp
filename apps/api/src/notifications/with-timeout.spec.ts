import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("제한 시간 안에 끝나면 결과를 돌려주고 타이머를 남기지 않는다", async () => {
    await expect(withTimeout(Promise.resolve(42), 5000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("원래 promise의 거부는 그대로 전달하고 타이머를 정리한다", async () => {
    await expect(withTimeout(Promise.reject(new Error("fcm down")), 5000)).rejects.toThrow("fcm down");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("끝나지 않으면 시간 초과로 거부한다", async () => {
    const hung = new Promise<never>(() => undefined);
    const result = expect(withTimeout(hung, 5000, "push")).rejects.toThrow("push timed out after 5000ms");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});

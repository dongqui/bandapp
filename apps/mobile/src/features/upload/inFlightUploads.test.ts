import { describe, expect, it } from "vitest";
import { createInFlightUploads } from "./inFlightUploads";

describe("createInFlightUploads", () => {
  it("has is false until add, true after, false again after delete", () => {
    const registry = createInFlightUploads();
    expect(registry.has("s1")).toBe(false);
    registry.add("s1");
    expect(registry.has("s1")).toBe(true);
    registry.delete("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it("delete on an id never added is a silent no-op", () => {
    const registry = createInFlightUploads();
    expect(() => registry.delete("never-added")).not.toThrow();
    expect(registry.has("never-added")).toBe(false);
  });

  it("add is idempotent", () => {
    const registry = createInFlightUploads();
    registry.add("s1");
    registry.add("s1");
    expect(registry.has("s1")).toBe(true);
    registry.delete("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it("each factory call produces an independent registry", () => {
    const a = createInFlightUploads();
    const b = createInFlightUploads();
    a.add("s1");
    expect(a.has("s1")).toBe(true);
    expect(b.has("s1")).toBe(false);
  });
});

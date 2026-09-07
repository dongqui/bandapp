import type { TakeComment } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { groupThreads } from "./threads";

const c = (id: string, atSec: number, createdAt: string, parentId: string | null = null): TakeComment => ({
  id,
  takeId: "t1",
  authorId: "u1",
  authorName: "A",
  parentId,
  atSec,
  text: id,
  createdAt,
});

describe("groupThreads", () => {
  it("최상위는 atSec 순, 같은 시점이면 createdAt 순", () => {
    const threads = groupThreads([c("b", 30, "2026-09-07T10:01:00Z"), c("a", 30, "2026-09-07T10:00:00Z"), c("z", 5, "2026-09-07T10:09:00Z")]);
    expect(threads.map((t) => t.comment.id)).toEqual(["z", "a", "b"]);
    expect(threads.every((t) => t.replies.length === 0)).toBe(true);
  });

  it("답글은 부모 아래 createdAt 순으로 붙는다", () => {
    const threads = groupThreads([
      c("p", 10, "2026-09-07T10:00:00Z"),
      c("r2", 10, "2026-09-07T10:02:00Z", "p"),
      c("r1", 10, "2026-09-07T10:01:00Z", "p"),
      c("q", 20, "2026-09-07T10:00:00Z"),
    ]);
    expect(threads.map((t) => t.comment.id)).toEqual(["p", "q"]);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(threads[1]!.replies).toEqual([]);
  });

  it("부모가 없는 답글은 버린다", () => {
    const threads = groupThreads([c("p", 10, "2026-09-07T10:00:00Z"), c("orphan", 10, "2026-09-07T10:01:00Z", "gone")]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies).toEqual([]);
  });
});

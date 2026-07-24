import { describe, it, expect } from "vitest";
import { applyMergePolicy, MERGE_PRESETS, type MergeFn } from "../src/merge.js";

describe("applyMergePolicy — presets", () => {
  it("prioritize-local prefers the project value, falling back to global", () => {
    expect(applyMergePolicy("prioritize-local", "p", "g")).toBe("p");
    expect(applyMergePolicy("prioritize-local", undefined, "g")).toBe("g");
    expect(applyMergePolicy("prioritize-local", "p", undefined)).toBe("p");
    expect(applyMergePolicy("prioritize-local", undefined, undefined)).toBeUndefined();
  });

  it("prioritize-global prefers the global value, falling back to project", () => {
    expect(applyMergePolicy("prioritize-global", "p", "g")).toBe("g");
    expect(applyMergePolicy("prioritize-global", "p", undefined)).toBe("p");
    expect(applyMergePolicy("prioritize-global", undefined, "g")).toBe("g");
  });

  it("prioritize-restrictive: any boolean false (opt-out) wins", () => {
    expect(applyMergePolicy("prioritize-restrictive", true, false)).toBe(false);
    expect(applyMergePolicy("prioritize-restrictive", false, true)).toBe(false);
    expect(applyMergePolicy("prioritize-restrictive", true, true)).toBe(true);
    // A single defined scope passes through.
    expect(applyMergePolicy("prioritize-restrictive", undefined, false)).toBe(false);
    expect(applyMergePolicy("prioritize-restrictive", true, undefined)).toBe(true);
  });

  it("prioritize-restrictive: numbers take the smaller (stricter) bound", () => {
    expect(applyMergePolicy("prioritize-restrictive", 5, 3)).toBe(3);
    expect(applyMergePolicy("prioritize-restrictive", 2, 9)).toBe(2);
  });

  it("union: de-duplicated concat of both arrays, global first", () => {
    expect(applyMergePolicy("union", ["b", "c"], ["a", "b"])).toEqual(["a", "b", "c"]);
    expect(applyMergePolicy("union", undefined, ["a"])).toEqual(["a"]);
    expect(applyMergePolicy("union", ["a"], undefined)).toEqual(["a"]);
  });

  it("intersection: elements present in both arrays, order follows project", () => {
    expect(applyMergePolicy("intersection", ["a", "b", "c"], ["b", "c", "d"])).toEqual(["b", "c"]);
    // A missing scope imposes no constraint — the present scope passes through.
    expect(applyMergePolicy("intersection", ["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(applyMergePolicy("intersection", undefined, ["x"])).toEqual(["x"]);
    expect(applyMergePolicy("intersection", ["a"], ["b"])).toEqual([]);
  });
});

describe("applyMergePolicy — custom function", () => {
  it("delegates to a supplied merge function", () => {
    const sum: MergeFn<number> = ({ local, global }) => (local ?? 0) + (global ?? 0);
    expect(applyMergePolicy(sum, 2, 3)).toBe(5);
    expect(applyMergePolicy(sum, undefined, 3)).toBe(3);
  });
});

describe("MERGE_PRESETS", () => {
  it("lists every preset name", () => {
    expect(MERGE_PRESETS).toEqual([
      "prioritize-local",
      "prioritize-global",
      "prioritize-restrictive",
      "union",
      "intersection",
    ]);
  });
});

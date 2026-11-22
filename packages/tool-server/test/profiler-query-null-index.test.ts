import { describe, it, expect } from "vitest";
import { profilerCommitQueryTool } from "../src/tools/profiler/query/profiler-commit-query";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";

// `z.coerce.number()` alone reads null as 0, so a null index would silently pick the first
// commit or hang instead of reaching the tool's "requires the ... parameter" error.
describe("profiler query index params", () => {
  it("reads commit_index null as omitted", () => {
    const parse = (commit_index: unknown) =>
      profilerCommitQueryTool.zodSchema!.parse({
        port: 8081,
        device_id: "emulator-5554",
        mode: "by_index",
        commit_index,
      }).commit_index;
    expect(parse(null)).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
    expect(parse(0)).toBe(0);
    expect(parse("3")).toBe(3);
  });

  it("reads hang_index null as omitted", () => {
    const parse = (hang_index: unknown) =>
      profilerStackQueryTool.zodSchema!.parse({
        device_id: "emulator-5554",
        mode: "hang_stacks",
        hang_index,
      }).hang_index;
    expect(parse(null)).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
    expect(parse(0)).toBe(0);
    expect(parse("2")).toBe(2);
  });
});

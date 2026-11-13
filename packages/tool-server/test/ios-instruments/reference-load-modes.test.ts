import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

/**
 * IOS_PROFILER_REFERENCE.md named a `load_instruments` mode for profiler-load,
 * which the tool refuses as an invalid option. Every `mode=` the doc's
 * profiler-load section names must be one the schema accepts.
 */
const REFERENCE_MD = join(__dirname, "../../src/utils/ios-profiler/IOS_PROFILER_REFERENCE.md");

describe("IOS_PROFILER_REFERENCE.md profiler-load modes", () => {
  it("names only modes that profiler-load accepts", () => {
    const md = readFileSync(REFERENCE_MD, "utf8");
    const section = md.split(/^## /m).find((s) => s.includes("`profiler-load`"));
    expect(section).toBeDefined();
    const modes = [...section!.matchAll(/mode=([a-z_]+)/g)].map((m) => m[1]);
    expect(modes.length).toBeGreaterThan(0);
    for (const mode of modes) {
      const parsed = profilerLoadTool.zodSchema!.safeParse({
        mode,
        session_id: "20250313-143022",
        device_id: "device",
      });
      expect(parsed.success, mode).toBe(true);
    }
    expect(modes).toContain("load_native");
  });
});

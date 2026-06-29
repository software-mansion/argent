import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { reactProfilerComponentSourceTool } from "../../src/tools/profiler/react/react-profiler-component-source";

/**
 * End-to-end through the tool's execute(): when a component name resolves to
 * several files (platform variants), the lookup must return one deterministic
 * primary's source AND surface the rest under otherMatches — otherwise a caller
 * asking for "List" is silently handed whichever file the directory walk
 * happened to reach first, which may be the wrong platform variant.
 */
describe("react-profiler-component-source: duplicate component names", () => {
  it("returns the base-file primary source and surfaces variants under otherMatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "component-source-dup-"));
    mkdirSync(join(dir, "components"), { recursive: true });
    const base = join(dir, "components", "List.tsx");
    const web = join(dir, "components", "List.web.tsx");
    writeFileSync(base, `export function List() { return <View>NATIVE_MARKER</View>; }\n`);
    writeFileSync(web, `export function List() { return <div>WEB_MARKER</div>; }\n`);

    const result = (await reactProfilerComponentSourceTool.execute(
      {},
      { component_name: "List", project_root: dir }
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.file).toBe(base);
    // Source must come from the primary (base) file, not the web variant.
    expect(result.source).toContain("NATIVE_MARKER");
    expect(result.source).not.toContain("WEB_MARKER");
    expect(result.otherMatches).toEqual([{ file: web, line: 1, col: 16 }]);
  });

  it("omits otherMatches for a uniquely-named component", async () => {
    const dir = mkdtempSync(join(tmpdir(), "component-source-uniq-"));
    writeFileSync(join(dir, "Solo.tsx"), `export function Solo() { return <View />; }\n`);

    const result = (await reactProfilerComponentSourceTool.execute(
      {},
      { component_name: "Solo", project_root: dir }
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.otherMatches).toBeUndefined();
  });
});

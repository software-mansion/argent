import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { RESOLVE_FIBER_META_SCRIPT } from "../../src/utils/react-profiler/scripts";

/**
 * RESOLVE_FIBER_META_SCRIPT runs inside the connected app's runtime and keys
 * its output by component display name. Names are untrusted: "__proto__" and
 * "constructor" must become own data properties of the accumulation object,
 * not inherited members that make the membership check skip real fibers.
 */
function runScript(fiber: unknown): string {
  const hook = {
    __argent_roots__: [{ current: fiber }],
  };
  return runInNewContext(RESOLVE_FIBER_META_SCRIPT, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    JSON,
    Object,
  }) as string;
}

const named = (name: string) => ({ type: { name }, return: null });

describe("RESOLVE_FIBER_META_SCRIPT — hostile component names", () => {
  it("collects a fiber named __proto__ instead of skipping it as an inherited key", () => {
    const parsed = JSON.parse(runScript(named("__proto__"))) as Record<
      string,
      { parentName: unknown }
    >;
    expect(Object.keys(parsed)).toContain("__proto__");
    expect(parsed["__proto__"]).toEqual({
      hookTypes: null,
      isCompilerOptimized: false,
      parentName: null,
    });
    expect(({} as Record<string, unknown>).parentName).toBeUndefined();
  });

  it("collects a fiber named constructor under its own key", () => {
    const parsed = JSON.parse(runScript(named("constructor"))) as Record<
      string,
      { parentName: unknown }
    >;
    expect(Object.keys(parsed)).toContain("constructor");
  });
});

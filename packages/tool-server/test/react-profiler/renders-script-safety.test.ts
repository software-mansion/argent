import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { __testables } from "../../src/tools/profiler/react/react-profiler-renders";

/**
 * COLLECT_RENDERS_SCRIPT runs inside the connected app's runtime. Component
 * names come from whatever libraries and data the app renders, so the script's
 * accumulation object must treat every name — including "__proto__" and
 * "constructor" — as an own data property, never as an inherited accessor.
 */
const { COLLECT_RENDERS_SCRIPT } = __testables;

function runScript(fiber: unknown): string {
  const hook = {
    _renderers: { 1: {} },
    __argent_roots__: [{ current: fiber }],
  };
  return runInNewContext(COLLECT_RENDERS_SCRIPT, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    JSON,
    Object,
  }) as string;
}

const named = (name: string) => ({ type: name, actualDuration: 5, selfBaseDuration: 1 });

describe("COLLECT_RENDERS_SCRIPT — hostile component names", () => {
  it("keeps a fiber named __proto__ as an own row instead of writing through Object.prototype", () => {
    const json = runScript(named("__proto__"));
    const parsed = JSON.parse(json) as Record<string, { instanceCount: number }>;

    expect(parsed["__proto__"]!.instanceCount).toBe(1);
    expect(Object.keys(parsed)).toContain("__proto__");
    // The pollution this guards against: ({}).instanceCount would read NaN.
    expect(({} as Record<string, unknown>).instanceCount).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "instanceCount")).toBeUndefined();
  });

  it("accumulates a fiber named constructor under its own key", () => {
    const parsed = JSON.parse(runScript(named("constructor"))) as Record<
      string,
      { instanceCount: number }
    >;
    expect(parsed["constructor"]!.instanceCount).toBe(1);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "instanceCount")).toBeUndefined();
  });
});

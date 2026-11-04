import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  COLLECT_RENDERS_SCRIPT,
  reactProfilerRendersTool,
} from "../../src/tools/profiler/react/react-profiler-renders";

type Row = { instanceCount: number; maxActualDuration: number; selfBaseDuration: number };

function evaluate(expression: string, rootFiber: unknown): string {
  const hook = {
    _renderers: { 1: {} },
    __argent_roots__: [{ current: rootFiber }],
  };
  return runInNewContext(expression, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    JSON,
    Object,
  }) as string;
}

function runScript(rootFiber: unknown): Record<string, Row> {
  return JSON.parse(evaluate(COLLECT_RENDERS_SCRIPT, rootFiber)) as Record<string, Row>;
}

const fiber = (
  type: string,
  actualDuration: number,
  selfBaseDuration: number,
  child: unknown = null,
  sibling: unknown = null
) => ({ type, actualDuration, selfBaseDuration, child, sibling });

const view = (
  actualDuration: number,
  selfBaseDuration: number,
  child?: unknown,
  sibling?: unknown
) => fiber("View", actualDuration, selfBaseDuration, child, sibling);

describe("COLLECT_RENDERS_SCRIPT — same-name fibers", () => {
  it("reports the largest nested instance's subtree and the summed self", () => {
    const row = runScript(view(20, 1, view(15, 1, view(10, 1))))["View"]!;

    expect(row.instanceCount).toBe(3);
    expect(row.maxActualDuration).toBe(20);
    expect(row.selfBaseDuration).toBe(3);
  });

  it("keeps the largest sibling when a smaller one is walked after it", () => {
    const row = runScript(view(9, 1, null, view(5, 1)))["View"]!;

    expect(row.instanceCount).toBe(2);
    expect(row.maxActualDuration).toBe(9);
  });
});

describe("react-profiler-renders", () => {
  it("ranks by self time, not by the largest subtree", async () => {
    // Wrapper: 50ms subtree, 1ms self. Leaf: 10ms subtree, 10ms self.
    const tree = fiber("Wrapper", 50, 1, fiber("Leaf", 10, 10));
    const cdp = {
      send: async (_method: string, { expression }: { expression: string }) => ({
        result: { value: evaluate(expression, tree) },
      }),
      evaluate: async () => undefined,
    };
    const services = { profilerSession: { cdp, profilingActive: false } };
    const params = { device_id: "test", top_n: 1 };

    const markdown = await reactProfilerRendersTool.execute(
      services as unknown as Parameters<typeof reactProfilerRendersTool.execute>[0],
      params as unknown as Parameters<typeof reactProfilerRendersTool.execute>[1]
    );

    expect(markdown).toContain("| `Leaf` | 1 | 10.00 | 10.00 |");
    expect(markdown).not.toContain("Wrapper");
  });
});

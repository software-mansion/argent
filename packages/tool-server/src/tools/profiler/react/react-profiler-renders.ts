import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  FIBER_ROOT_TRACKER_SCRIPT,
  type ReactProfilerSessionApi,
} from "../../../blueprints/react-profiler-session";

const COLLECT_RENDERS_SCRIPT = `
(function() {
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'no __REACT_DEVTOOLS_GLOBAL_HOOK__' });

    var renderers = hook._renderers || hook.renderers;
    if (!renderers) return JSON.stringify({ error: 'no renderers attached to hook' });

    var results = {};

    function walkFiber(fiber, depth) {
      if (!fiber || depth > 30) return;
      var name = null;
      if (fiber.type) {
        if (typeof fiber.type === 'string') name = fiber.type;
        else if (fiber.type.displayName) name = fiber.type.displayName;
        else if (fiber.type.name) name = fiber.type.name;
      }
      if (name && fiber.actualDuration !== undefined) {
        if (!results[name]) results[name] = { renderCount: 0, totalActualDuration: 0, selfBaseDuration: 0 };
        results[name].renderCount += 1;
        results[name].totalActualDuration += fiber.actualDuration || 0;
        results[name].selfBaseDuration += fiber.selfBaseDuration || 0;
      }
      if (fiber.child) walkFiber(fiber.child, depth + 1);
      if (fiber.sibling) walkFiber(fiber.sibling, depth);
    }

    var roots = hook.__argent_roots__ || hook._fiberRoots || hook.fiberRoots;
    if (roots) {
      var iter = roots.values ? roots.values() : Object.values(roots);
      for (var root of iter) {
        if (root.current) walkFiber(root.current, 0);
      }
    }

    return JSON.stringify(results);
  } catch(e) {
    return JSON.stringify({ error: String(e) });
  }
})()
`;

const HOOK_NOT_PRESENT_ERRORS = new Set([
  "no __REACT_DEVTOOLS_GLOBAL_HOOK__",
  "no renderers attached to hook",
]);

const HOOK_MISSING_MESSAGE =
  "React DevTools hook not present. Ensure the app is in development mode. " +
  "Try calling react-profiler-start first to re-inject the hook.";

type ParsedRenders =
  | Record<
      string,
      {
        renderCount: number;
        totalActualDuration: number;
        selfBaseDuration: number;
      }
    >
  | { error: string };

interface RenderEntry {
  component: string;
  renderCount: number;
  totalActualDuration_ms: number;
  selfBaseDuration_ms: number;
}

function renderMarkdownTable(entries: RenderEntry[]): string {
  if (entries.length === 0)
    return "_No render data found. Ensure React DevTools global hook is present._";
  const header = "| Component | Renders | Total (ms) | Self Base (ms) |";
  const sep = "|---|---|---|---|";
  const rows = entries.map(
    (e) =>
      `| \`${e.component}\` | ${e.renderCount} | ${e.totalActualDuration_ms.toFixed(2)} | ${e.selfBaseDuration_ms.toFixed(2)} |`
  );
  return [header, sep, ...rows].join("\n");
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Number of top re-rendering components to return (default 20)"),
});

export const reactProfilerRendersTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "react-profiler-renders",
  description: `Walk the live React fiber tree to collect component render counts and durations.
Returns a markdown table of the top re-rendering components. No profiling session required — works on a live connected app.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;
    const cdp = api.cdp;

    type EvalResult = {
      result?: { value?: string };
      exceptionDetails?: { text?: string };
    };

    async function evalRenders(): Promise<EvalResult> {
      return cdp.send("Runtime.evaluate", {
        expression: COLLECT_RENDERS_SCRIPT,
        returnByValue: true,
        timeout: 5000,
      }) as Promise<EvalResult>;
    }

    let result = await evalRenders();

    if (result?.exceptionDetails) {
      throw new Error(`Runtime exception: ${result.exceptionDetails.text ?? "unknown"}`);
    }

    if (!result?.result?.value) {
      throw new Error("No data returned from runtime evaluation.");
    }

    let parsed = JSON.parse(result.result.value) as ParsedRenders;

    function getErrorString(p: ParsedRenders): string | null {
      if ("error" in p && typeof (p as { error?: unknown }).error === "string") {
        return (p as { error: string }).error;
      }
      return null;
    }

    // Re-inject hook once if missing and retry
    const firstError = getErrorString(parsed);
    if (firstError !== null && HOOK_NOT_PRESENT_ERRORS.has(firstError)) {
      await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(() => {});
      result = await evalRenders();
      if (result?.result?.value) {
        parsed = JSON.parse(result.result.value) as ParsedRenders;
      }
    }

    const errorStr = getErrorString(parsed);
    if (errorStr !== null) {
      throw new Error(
        HOOK_NOT_PRESENT_ERRORS.has(errorStr)
          ? HOOK_MISSING_MESSAGE
          : `React hook error: ${errorStr}`
      );
    }

    const entries: RenderEntry[] = Object.entries(parsed)
      .map(([component, data]) => ({
        component,
        renderCount: data.renderCount,
        totalActualDuration_ms: data.totalActualDuration,
        selfBaseDuration_ms: data.selfBaseDuration,
      }))
      .sort((a, b) => b.totalActualDuration_ms - a.totalActualDuration_ms)
      .slice(0, params.top_n);

    return `## React Component Renders\n\n${renderMarkdownTable(entries)}`;
  },
};

import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
} from "../../../blueprints/react-profiler-session";
import { HEARTBEAT_SCRIPT, FIBER_ROOT_TRACKER_SCRIPT } from "../../../utils/react-profiler/scripts";
import { NO_DEVTOOLS_HOOK_ERROR, NO_RENDERERS_ATTACHED_ERROR } from "./react-profiler-start";

const COLLECT_RENDERS_SCRIPT = `
(function() {
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'no __REACT_DEVTOOLS_GLOBAL_HOOK__' });

    var renderers = hook._renderers || hook.renderers;
    if (!renderers) return JSON.stringify({ error: 'no renderers attached to hook' });

    // Null prototype: a fiber named "__proto__" or "constructor" must become
    // an own data property, not write through an inherited accessor onto
    // Object.prototype of the debuggee app.
    var results = Object.create(null);

    function walkFiber(fiber, depth) {
      if (!fiber || depth > 30) return;
      var name = null;
      if (fiber.type) {
        if (typeof fiber.type === 'string') name = fiber.type;
        else if (fiber.type.displayName) name = fiber.type.displayName;
        else if (fiber.type.name) name = fiber.type.name;
      }
      if (name && fiber.actualDuration !== undefined) {
        if (!results[name]) results[name] = { instanceCount: 0, maxActualDuration: 0, selfBaseDuration: 0 };
        results[name].instanceCount += 1;
        var inclusive = fiber.actualDuration || 0;
        if (inclusive > results[name].maxActualDuration) results[name].maxActualDuration = inclusive;
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

const HOOK_MISSING_ERROR = "no __REACT_DEVTOOLS_GLOBAL_HOOK__";
const NO_RENDERERS_ERROR = "no renderers attached to hook";
const HOOK_NOT_PRESENT_ERRORS = new Set([HOOK_MISSING_ERROR, NO_RENDERERS_ERROR]);

// Both codes share the retry path but need different remediation text.
function messageForHookError(code: string): string {
  if (code === HOOK_MISSING_ERROR) return NO_DEVTOOLS_HOOK_ERROR;
  if (code === NO_RENDERERS_ERROR) return NO_RENDERERS_ATTACHED_ERROR;
  return `React hook error: ${code}`;
}

type ParsedRenders =
  | Record<
      string,
      {
        instanceCount: number;
        maxActualDuration: number;
        selfBaseDuration: number;
      }
    >
  | { error: string };

interface RenderEntry {
  component: string;
  instanceCount: number;
  maxActualDuration_ms: number;
  selfBaseDuration_ms: number;
}

function renderMarkdownTable(entries: RenderEntry[]): string {
  if (entries.length === 0)
    return "_No render data found. Ensure React DevTools global hook is present._";
  const header = "| Component | Instances | Largest subtree (ms) | Self Base (ms) |";
  const sep = "|---|---|---|---|";
  const rows = entries.map(
    (e) =>
      `| \`${e.component}\` | ${e.instanceCount} | ${e.maxActualDuration_ms.toFixed(2)} | ${e.selfBaseDuration_ms.toFixed(2)} |`
  );
  return [header, sep, ...rows].join("\n");
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Number of top components to return, by self render time (default 20)"),
});

/** Exposed for tests: the injected script runs on the debuggee, so its object handling is load-bearing. */
export const __testables = { COLLECT_RENDERS_SCRIPT };

export const reactProfilerRendersTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "react-profiler-renders",
  interaction: {
    startedMsg: () => "Reading React render activity",
    completedMsg: () => "Read React render activity",
    failedMsg: ({ failureSignal }) =>
      `Failed to read React render activity: ${failureSignal.error_code}`,
  },
  description: `Scan the live React fiber tree for the components costing the most render time right now.
Returns a markdown table sorted by self time: how many instances of each component are mounted, the largest single instance's subtree time, and total self time. It is a snapshot of the tree as it stands, not a recording, so the instance count is how many exist — not how many times they re-rendered.
Use for a quick read on which components are expensive without starting a profiling session; use react-profiler-start/stop when you need re-render counts and the reasons behind them.
Fails if the React DevTools hook is not present in the runtime or the app is not connected.`,
  zodSchema,
  // RN-only: queries the React DevTools backend hook on the live runtime.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}:${params.device_id}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;
    const cdp = api.cdp;

    if (api.profilingActive && api.ownerToolServerPid === process.pid) {
      await cdp.evaluate(HEARTBEAT_SCRIPT).catch(() => {});
    }

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
      throw new FailureError(`Runtime exception: ${result.exceptionDetails.text ?? "unknown"}`, {
        error_code: FAILURE_CODES.REACT_PROFILER_RUNTIME_EXCEPTION,
        failure_stage: "react_profiler_renders_runtime_eval",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }

    if (!result?.result?.value) {
      throw new FailureError("No data returned from runtime evaluation.", {
        error_code: FAILURE_CODES.REACT_PROFILER_NO_RUNTIME_DATA,
        failure_stage: "react_profiler_renders_runtime_eval",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }

    let parsed = JSON.parse(result.result.value) as ParsedRenders;

    function getErrorString(p: ParsedRenders): string | null {
      if ("error" in p && typeof (p as { error?: unknown }).error === "string") {
        return (p as { error: string }).error;
      }
      return null;
    }

    const firstError = getErrorString(parsed);
    if (firstError !== null && HOOK_NOT_PRESENT_ERRORS.has(firstError)) {
      await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(() => {});
      result = await evalRenders();
      if (result?.exceptionDetails) {
        throw new FailureError(`Runtime exception: ${result.exceptionDetails.text ?? "unknown"}`, {
          error_code: FAILURE_CODES.REACT_PROFILER_RUNTIME_EXCEPTION,
          failure_stage: "react_profiler_renders_runtime_eval",
          failure_area: "tool_server",
          error_kind: "subprocess",
        });
      }
      if (result?.result?.value) {
        parsed = JSON.parse(result.result.value) as ParsedRenders;
      }
    }

    const errorStr = getErrorString(parsed);
    if (errorStr !== null) {
      throw new FailureError(messageForHookError(errorStr), {
        error_code: HOOK_NOT_PRESENT_ERRORS.has(errorStr)
          ? FAILURE_CODES.REACT_PROFILER_DEVTOOLS_HOOK_MISSING
          : FAILURE_CODES.REACT_PROFILER_HOOK_ERROR,
        failure_stage: "react_profiler_renders_hook_read",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    const entries: RenderEntry[] = Object.entries(parsed)
      .map(([component, data]) => ({
        component,
        // These cross the debuggee→host boundary as JSON; a non-finite duration
        // serializes to null, and null.toFixed throws.
        instanceCount: data.instanceCount ?? 0,
        maxActualDuration_ms: data.maxActualDuration ?? 0,
        selfBaseDuration_ms: data.selfBaseDuration ?? 0,
      }))
      .sort((a, b) => b.selfBaseDuration_ms - a.selfBaseDuration_ms)
      .slice(0, params.top_n);

    return `## React Component Renders\n\n${renderMarkdownTable(entries)}`;
  },
};

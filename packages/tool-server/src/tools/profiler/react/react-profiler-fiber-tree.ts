import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
} from "../../../blueprints/react-profiler-session";
import { HEARTBEAT_SCRIPT, FIBER_ROOT_TRACKER_SCRIPT } from "../../../utils/react-profiler/scripts";
import { NO_DEVTOOLS_HOOK_ERROR, NO_RENDERERS_ATTACHED_ERROR } from "./react-profiler-start";

const HOOK_MISSING_ERROR = "no __REACT_DEVTOOLS_GLOBAL_HOOK__";
const NO_RENDERERS_ERROR = "no renderers attached to hook";
const HOOK_NOT_PRESENT_ERRORS = new Set([HOOK_MISSING_ERROR, NO_RENDERERS_ERROR]);

// See `react-profiler-renders.ts` for the rationale — branch on the actual
// error code so "hook missing" (rebuild in dev mode) and "renderers not
// attached" (wait for first render / let start bootstrap) get accurate
// remediation instead of being collapsed into one misleading message.
function messageForHookError(code: string): string {
  if (code === HOOK_MISSING_ERROR) return NO_DEVTOOLS_HOOK_ERROR;
  if (code === NO_RENDERERS_ERROR) return NO_RENDERERS_ATTACHED_ERROR;
  return `Fiber tree error: ${code}`;
}

function buildFiberTreeScript(maxDepth: number, filter: string): string {
  return `
(function() {
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'no __REACT_DEVTOOLS_GLOBAL_HOOK__' });

    var maxDepth = ${maxDepth};
    var filterRe = ${filter ? `new RegExp(${JSON.stringify(filter)})` : "null"};

    function getComponentName(fiber) {
      if (!fiber || !fiber.type) return null;
      if (typeof fiber.type === 'string') return fiber.type;
      return fiber.type.displayName || fiber.type.name || null;
    }

    function buildTree(fiber, depth) {
      if (!fiber || depth > maxDepth) return null;
      var name = getComponentName(fiber) || '(' + fiber.tag + ')';

      if (filterRe && !filterRe.test(name)) {
        var kids = [];
        if (fiber.child) {
          var child = fiber.child;
          while (child) {
            var subtree = buildTree(child, depth);
            if (subtree) kids.push(subtree);
            child = child.sibling;
          }
        }
        return kids.length === 1 ? kids[0] : kids.length > 1 ? { name: '(group)', children: kids } : null;
      }

      var node = { name: name, tag: fiber.tag, actualDuration: fiber.actualDuration, selfBaseDuration: fiber.selfBaseDuration, children: [] };

      if (fiber.child && depth < maxDepth) {
        var child = fiber.child;
        while (child) {
          var subtree = buildTree(child, depth + 1);
          if (subtree) node.children.push(subtree);
          child = child.sibling;
        }
      } else if (fiber.child) {
        node.truncated = true;
      }

      return node;
    }

    function countNodes(fiber, depth) {
      if (!fiber || depth > 50) return 0;
      return 1 + countNodes(fiber.child, depth + 1) + countNodes(fiber.sibling, depth);
    }

    var roots = hook.__argent_roots__ || hook._fiberRoots || hook.fiberRoots;
    if (!roots || roots.size === 0) return JSON.stringify([]);

    var iter = roots.values ? roots.values() : Object.values(roots);
    var bestRoot = null, bestCount = 0;
    for (var root of iter) {
      var count = root.current ? countNodes(root.current, 0) : 0;
      if (count > bestCount) { bestCount = count; bestRoot = root; }
    }

    if (!bestRoot || !bestRoot.current) return JSON.stringify([]);
    var tree = buildTree(bestRoot.current, 0);
    return JSON.stringify(tree ? [tree] : []);
  } catch(e) {
    return JSON.stringify({ error: String(e) });
  }
})()`;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
  max_depth: z.coerce
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum tree depth to traverse (default 10)"),
  filter: z.string().optional().describe("Regex string to filter component names"),
});

export const reactProfilerFiberTreeTool: ToolDefinition<z.infer<typeof zodSchema>, unknown> = {
  id: "react-profiler-fiber-tree",
  description: `Inspect the React fiber tree and return a JSON representation of the component hierarchy.
Use when tracing ancestry of a library component or checking for useMemoCache hook (confirms React Compiler is active on a component).
Returns a nested JSON tree of fiber nodes with name, tag, actualDuration, selfBaseDuration, and children.
Fails if the React DevTools hook is not present or no fiber roots have been committed yet.`,
  zodSchema,
  // RN-only: walks the fiber tree via the React DevTools backend hook.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}:${params.device_id}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;
    const cdp = api.cdp;

    // Bump owner heartbeat only when this tool-server owns the active session.
    if (api.profilingActive && api.ownerToolServerPid === process.pid) {
      await cdp.evaluate(HEARTBEAT_SCRIPT).catch(() => {});
    }

    const script = buildFiberTreeScript(params.max_depth, params.filter ?? "");

    type FiberEvalResult = {
      result?: { value?: string };
      exceptionDetails?: { text?: string };
    };

    async function evalFiberTree(): Promise<FiberEvalResult> {
      return cdp.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        timeout: 5000,
      }) as Promise<FiberEvalResult>;
    }

    let result = await evalFiberTree();

    if (result?.exceptionDetails) {
      throw new FailureError(`Runtime exception: ${result.exceptionDetails.text ?? "unknown"}`, {
        error_code: FAILURE_CODES.REACT_PROFILER_RUNTIME_EXCEPTION,
        failure_stage: "react_profiler_fiber_tree_runtime_eval",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }

    if (!result?.result?.value) {
      throw new FailureError("No data returned from runtime evaluation.", {
        error_code: FAILURE_CODES.REACT_PROFILER_NO_RUNTIME_DATA,
        failure_stage: "react_profiler_fiber_tree_runtime_eval",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }

    let parsed = JSON.parse(result.result.value) as unknown;

    // Re-inject hook once if missing and retry
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      HOOK_NOT_PRESENT_ERRORS.has((parsed as { error: string }).error)
    ) {
      await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(() => {});
      result = await evalFiberTree();
      if (result?.result?.value) {
        parsed = JSON.parse(result.result.value) as unknown;
      }
    }

    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const errorMsg = (parsed as { error: string }).error;
      throw new FailureError(messageForHookError(errorMsg), {
        error_code: HOOK_NOT_PRESENT_ERRORS.has(errorMsg)
          ? FAILURE_CODES.REACT_PROFILER_DEVTOOLS_HOOK_MISSING
          : FAILURE_CODES.REACT_PROFILER_HOOK_ERROR,
        failure_stage: "react_profiler_fiber_tree_hook_read",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    if (Array.isArray(parsed) && parsed.length === 0) {
      return {
        tree: null,
        message:
          "No fiber tree available yet. The React DevTools hook has not received any commits. " +
          "Try interacting with the app first.",
      };
    }

    return parsed;
  },
};

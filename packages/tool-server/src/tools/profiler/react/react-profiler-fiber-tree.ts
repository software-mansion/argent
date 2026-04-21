import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  FIBER_ROOT_TRACKER_SCRIPT,
  type ReactProfilerSessionApi,
} from "../../../blueprints/react-profiler-session";
import { HEARTBEAT_SCRIPT } from "../../../utils/react-profiler/scripts";

const HOOK_NOT_PRESENT_ERRORS = new Set([
  "no __REACT_DEVTOOLS_GLOBAL_HOOK__",
  "no renderers attached to hook",
]);

const HOOK_MISSING_MESSAGE =
  "React DevTools hook not present. Ensure the app is in development mode. " +
  "Try calling react-profiler-start first to re-inject the hook.";

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
  device_id: z.string().describe("iOS Simulator UDID (logicalDeviceId)."),
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
      throw new Error(`Runtime exception: ${result.exceptionDetails.text ?? "unknown"}`);
    }

    if (!result?.result?.value) {
      throw new Error("No data returned from runtime evaluation.");
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
      throw new Error(
        HOOK_NOT_PRESENT_ERRORS.has(errorMsg)
          ? HOOK_MISSING_MESSAGE
          : `Fiber tree error: ${errorMsg}`
      );
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

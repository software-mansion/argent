import { z } from "zod";
import {
  type Registry,
  type ToolDefinition,
  ServiceState,
} from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  clearCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import { JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../../blueprints/js-runtime-debugger";

const COMMIT_CAPTURE_SCRIPT = `
(function __argent_commitCaptureInit() {
  globalThis.__RN_DEVTOOLS_MCP_COMMITS__ = [];
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;
  hook.__rn_mcp_commit_capture__ = true;
  var origOnCommit = hook.onCommitFiberRoot;
  var commitIndex = 0;

  function __argent_getChangedHookIndices(fiber) {
    if (!fiber.alternate) return null;
    var changed = [];
    var curr = fiber.memoizedState;
    var prev = fiber.alternate.memoizedState;
    var idx = 0;
    try {
      while (curr) {
        if (prev && curr.memoizedState !== prev.memoizedState) changed.push(idx);
        curr = curr.next;
        prev = prev ? prev.next : null;
        idx++;
        if (idx > 100) break;
      }
    } catch(e) {}
    return changed.length > 0 ? changed : null;
  }

  function __argent_getNearestParentName(fiber) {
    var ret = fiber.return;
    while (ret) {
      var pn = (ret.type && (ret.type.displayName || ret.type.name)) || null;
      if (pn) return pn;
      ret = ret.return;
    }
    return null;
  }

  hook.onCommitFiberRoot = function __argent_onCommitFiberRoot(rendererID, root, priorityLevel) {
    var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var idx = commitIndex++;
    var commitDur = (root && root.current && typeof root.current.actualDuration === 'number')
      ? root.current.actualDuration : 0;
    var stack = root && root.current ? [root.current] : [];
    while (stack.length > 0) {
      var fiber = stack.pop();
      if (!fiber) continue;
      try {
        var name = (fiber.type && (fiber.type.displayName || fiber.type.name)) || null;
        if (name && typeof fiber.actualDuration === 'number') {
          var isFirst = fiber.alternate === null;
          var cd = null;
          if (!isFirst && fiber.alternate) {
            var pp = fiber.alternate.memoizedProps || {};
            var cp = fiber.memoizedProps || {};
            var changed = [];
            var keys = Object.keys(cp);
            for (var i = 0; i < keys.length; i++) {
              if (pp[keys[i]] !== cp[keys[i]]) changed.push(keys[i]);
            }
            var ppkeys = Object.keys(pp);
            for (var j = 0; j < ppkeys.length; j++) {
              if (!(ppkeys[j] in cp)) changed.push(ppkeys[j]);
            }
            var changedHooks = __argent_getChangedHookIndices(fiber);
            var hasContextDeps = false;
            try { hasContextDeps = fiber.dependencies !== null && fiber.dependencies !== undefined; } catch(e) {}
            cd = {
              props: changed.length > 0 ? changed : null,
              state: false,
              hooks: changedHooks,
              context: hasContextDeps && changed.length === 0 && changedHooks === null,
              didHooksChange: changedHooks !== null,
              isFirstMount: false
            };
          } else {
            cd = { props: null, state: false, hooks: null, context: false, didHooksChange: false, isFirstMount: true };
          }
          var hookTypes = (fiber._debugHookTypes && fiber._debugHookTypes.length > 0) ? fiber._debugHookTypes : null;
          var isCompilerOptimized = false;
          try {
            // Check current fiber's updateQueue (React 18.3+ / 19)
            if (fiber.updateQueue && fiber.updateQueue.memoCache != null) isCompilerOptimized = true;
            // Also check alternate fiber (the previous committed version)
            if (!isCompilerOptimized && fiber.alternate && fiber.alternate.updateQueue && fiber.alternate.updateQueue.memoCache != null) isCompilerOptimized = true;
          } catch(e) {}
          if (!isCompilerOptimized && fiber._debugHookTypes) {
            for (var hi = 0; hi < fiber._debugHookTypes.length; hi++) {
              var ht = fiber._debugHookTypes[hi];
              // 'useMemoCache' = React 19 internal name; 'MemoCache' = DevTools debug name;
              // 'unstable_useMemoCache' = React 18 export name used by react/compiler-runtime
              if (ht === 'useMemoCache' || ht === 'MemoCache' || ht === 'unstable_useMemoCache') { isCompilerOptimized = true; break; }
            }
          }
          var parentName = __argent_getNearestParentName(fiber);
          globalThis.__RN_DEVTOOLS_MCP_COMMITS__.push({
            commitIndex: idx,
            timestamp: ts,
            componentName: name,
            actualDuration: fiber.actualDuration,
            selfDuration: fiber.selfBaseDuration || 0,
            commitDuration: commitDur,
            didRender: fiber.actualDuration > 0,
            changeDescription: cd,
            hookTypes: hookTypes,
            parentName: parentName,
            isCompilerOptimized: isCompilerOptimized
          });
        }
      } catch(e) {}
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    if (typeof origOnCommit === 'function') origOnCommit.call(this, rendererID, root, priorityLevel);
  };
})();
`;

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  sample_interval_us: z.coerce
    .number()
    .int()
    .positive()
    .default(100)
    .describe("CPU sampling interval in microseconds (default 100)"),
});

function safeGetState(registry: Registry, urn: string): ServiceState | null {
  try {
    return registry.getServiceState(urn);
  } catch {
    return null;
  }
}

export function createReactProfilerStartTool(
  registry: Registry,
): ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    started_at: string;
    startedAtEpochMs: number;
    hermes_version: string;
    detected_architecture: string | null;
  }
> {
  return {
    id: "react-profiler-start",
    description: `Start CPU profiling + React commit capture on the connected Hermes runtime.
Sets up the ReactProfilerSession (auto-connects to Metro if not already connected), then starts CPU sampling and injects the React fiber commit-capture hook.
Before calling this, ask the user if they also want native iOS profiling (ios-profiler-start) — recommend running both in parallel for a complete picture.
After starting, ask the user to perform the interaction to profile, then call react-profiler-stop.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const jsdUrn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${params.port}`;
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`;
      const ignore = () => {};

      async function disposeAndWait() {
        try {
          await registry.disposeService(psUrn);
        } catch {
          /* ignore */
        }
        try {
          await registry.disposeService(jsdUrn);
        } catch {
          /* ignore */
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const jsdState = safeGetState(registry, jsdUrn);
          const psState = safeGetState(registry, psUrn);
          if (
            jsdState !== ServiceState.TERMINATING &&
            psState !== ServiceState.TERMINATING
          )
            break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // Pre-clean: if either service is in a non-healthy state, dispose both so
      // resolveService starts fresh instead of hitting "terminated during init".
      const snapshot = registry.getSnapshot();
      const psEntry = snapshot.services.get(psUrn);
      const jsdEntry = snapshot.services.get(jsdUrn);
      if (
        (psEntry &&
          psEntry.state !== ServiceState.RUNNING &&
          psEntry.state !== ServiceState.IDLE) ||
        (jsdEntry &&
          jsdEntry.state !== ServiceState.RUNNING &&
          jsdEntry.state !== ServiceState.IDLE)
      ) {
        await disposeAndWait();
      }

      let api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);

      if (!api.cdp.isConnected()) {
        await disposeAndWait();
        api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);

        if (!api.cdp.isConnected()) {
          throw new Error(
            "CDP connection not available. The Hermes runtime may still be loading. Call react-profiler-start again.",
          );
        }
      }

      const cdp = api.cdp;

      // If a previous stop failed mid-execution, profilingActive may still be true.
      // Stop the profiler first to avoid a double-start error in Hermes.
      if (api.profilingActive) {
        await cdp.send("Profiler.stop").catch(ignore);
        api.profilingActive = false;
      }

      // Inject commit-capture hook FIRST (before startProfiling) so no commits are missed
      await cdp.evaluate(COMMIT_CAPTURE_SCRIPT);

      // Re-enable Profiler domain (no-op if already enabled, re-enables after Fast Refresh)
      await cdp.send("Profiler.enable").catch(ignore);

      await cdp.send("Profiler.start", {
        interval: params.sample_interval_us,
      });

      // Verify the hook was installed correctly
      const verifyResult = (await cdp.evaluate(`
        JSON.stringify({
          hookExists: typeof globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined',
          arrayCreated: Array.isArray(globalThis.__RN_DEVTOOLS_MCP_COMMITS__),
          hookPatched: !!globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.__rn_mcp_commit_capture__
        })
      `)) as string | undefined;

      let commitCaptureVerification: Record<string, boolean> | null = null;
      if (verifyResult) {
        commitCaptureVerification = JSON.parse(verifyResult) as Record<
          string,
          boolean
        >;
      }

      // Enable React profiling via DevTools hook (best-effort)
      await cdp
        .evaluate(
          `
          var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (hook) {
            hook._profiling = true;
            if (typeof hook.startProfiling === 'function') hook.startProfiling(true);
            if (hook.rendererInterfaces) {
              hook.rendererInterfaces.forEach(function(ri) {
                try { if (ri && ri.startProfiling) ri.startProfiling(true); } catch(e) {}
              });
            }
          }
          undefined
        `,
        )
        .catch(ignore);

      clearCachedProfilerPaths(api.port);
      api.sessionPaths = null;
      api.profilingActive = true;
      api.anyCompilerOptimized = null;
      api.hotCommitIndices = null;
      api.totalReactCommits = null;
      api.profileStartWallMs = Date.now();

      return {
        started_at: new Date(api.profileStartWallMs).toISOString(),
        startedAtEpochMs: api.profileStartWallMs,
        hermes_version: api.hermesVersion,
        detected_architecture: api.detectedArchitecture,
        ...(commitCaptureVerification && {
          commit_capture: commitCaptureVerification,
        }),
      };
    },
  };
}

import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { JsRuntimeDebuggerApi } from "./js-runtime-debugger";
import type {
  HermesCpuProfile,
  DevToolsCommitTree,
} from "../utils/react-profiler/types/input";
import type { CpuSampleIndex } from "../utils/react-profiler/pipeline/00-cpu-correlate";

export const REACT_PROFILER_SESSION_NAMESPACE = "ReactProfilerSession";

/**
 * Injected once on connect — tracks fiber root commits for get_react_renders
 * and get_fiber_tree. Idempotent (guard via __rn_mcp_installed__).
 */
export const FIBER_ROOT_TRACKER_SCRIPT = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || hook.__rn_mcp_installed__) return;
  hook.__rn_mcp_installed__ = true;
  hook.__rn_mcp_roots__ = new Set();

  var orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function(rendererID, root, priorityLevel) {
    hook.__rn_mcp_roots__.add(root);

    try {
      var stats = [];
      var stack = root && root.current ? [root.current] : [];
      while (stack.length > 0) {
        var fiber = stack.pop();
        if (!fiber) continue;
        var name = (fiber.type && (fiber.type.displayName || fiber.type.name)) || null;
        if (name && typeof fiber.actualDuration === 'number' && fiber.actualDuration > 0) {
          stats.push({ c: name, d: Math.round(fiber.actualDuration * 100) / 100 });
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      if (stats.length > 0) {
        console.log('[rn-mcp:render]', JSON.stringify(stats));
      }
    } catch(e) {}

    if (typeof orig === 'function') orig.call(this, rendererID, root, priorityLevel);
  };
})();
`;

export interface ScriptSourceEntry {
  url: string;
  sourceMapURL: string;
}

export interface ReactProfilerSessionApi {
  port: number;
  cdp: CDPClient;
  projectRoot: string;
  hermesVersion: string;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  cpuProfile: HermesCpuProfile | null;
  commitTree: DevToolsCommitTree | null;
  profilingActive: boolean;
  scriptSources: Map<string, ScriptSourceEntry>;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  profileStartWallMs: number | null;
}

export const reactProfilerSessionBlueprint: ServiceBlueprint<
  ReactProfilerSessionApi,
  string
> = {
  namespace: REACT_PROFILER_SESSION_NAMESPACE,

  getURN(port: string) {
    return `${REACT_PROFILER_SESSION_NAMESPACE}:${port}`;
  },

  getDependencies(port: string) {
    return { debugger: `JsRuntimeDebugger:${port}` };
  },

  async factory(deps, _payload) {
    const debuggerApi = deps.debugger as JsRuntimeDebuggerApi;
    const cdp = debuggerApi.cdp;
    const ignore = () => {};

    const state: ReactProfilerSessionApi = {
      port: debuggerApi.port,
      cdp,
      projectRoot: debuggerApi.projectRoot,
      hermesVersion: "unknown",
      detectedArchitecture: null,
      cpuProfile: null,
      commitTree: null,
      profilingActive: false,
      scriptSources: new Map<string, ScriptSourceEntry>(),
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
      profileStartWallMs: null,
    };

    // Enable Profiler domain
    await cdp.send("Profiler.enable").catch(ignore);

    // Track script sources for source map resolution in analyze_profile
    cdp.events.on("scriptParsed", (script) => {
      if (script.sourceMapURL) {
        state.scriptSources.set(script.scriptId, {
          url: script.url,
          sourceMapURL: script.sourceMapURL,
        });
      }
    });

    // Inject fiber root tracker (idempotent — guarded in JS)
    await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(ignore);

    // Detect RN architecture
    try {
      const archJson = (await cdp.evaluate(
        `JSON.stringify({
          bridgeless: typeof globalThis.RN$Bridgeless !== 'undefined' ? !!globalThis.RN$Bridgeless : null,
          turboModules: typeof globalThis.__turboModuleProxy !== 'undefined',
          fabric: typeof globalThis.nativeFabricUIManager !== 'undefined'
        })`,
      )) as string | undefined;

      if (archJson) {
        const flags = JSON.parse(archJson) as {
          bridgeless: boolean | null;
          turboModules: boolean;
          fabric: boolean;
        };
        if (flags.bridgeless === true) {
          state.detectedArchitecture = "bridgeless";
        } else if (flags.bridgeless === false) {
          state.detectedArchitecture = "bridge";
        } else if (flags.turboModules || flags.fabric) {
          state.detectedArchitecture = "bridgeless";
        } else {
          state.detectedArchitecture = "bridge";
        }
      }
    } catch {
      // non-fatal
    }

    // Get Hermes version
    try {
      const propsJson = (await cdp.evaluate(
        "JSON.stringify(HermesInternal.getRuntimeProperties())",
      )) as string | undefined;

      if (propsJson) {
        const props = JSON.parse(propsJson) as Record<string, unknown>;
        state.hermesVersion =
          (props["OSS Release Version"] as string) ?? "unknown";
      }
    } catch {
      // non-fatal
    }

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api: state,
      dispose: async () => {
        if (state.profilingActive) {
          await cdp.send("Profiler.stop").catch(ignore);
          state.profilingActive = false;
        }
        await cdp.send("Profiler.disable").catch(ignore);
      },
      events,
    };
  },
};

export interface ProfilerDataSnapshot {
  cpuProfile: HermesCpuProfile;
  commitTree: DevToolsCommitTree;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  cpuSampleIndex?: CpuSampleIndex | null;
}

const profilerDataCache = new Map<number, ProfilerDataSnapshot>();

export function cacheProfilerData(
  port: number,
  snapshot: ProfilerDataSnapshot,
): void {
  profilerDataCache.set(port, snapshot);
}

export function getCachedProfilerData(
  port: number,
): ProfilerDataSnapshot | undefined {
  return profilerDataCache.get(port);
}

export function clearCachedProfilerData(port: number): void {
  profilerDataCache.delete(port);
}

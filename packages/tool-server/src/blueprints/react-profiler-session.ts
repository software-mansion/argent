import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { JsRuntimeDebuggerApi } from "./js-runtime-debugger";

export const REACT_PROFILER_SESSION_NAMESPACE = "ReactProfilerSession";

/**
 * Injected once on connect — tracks fiber root commits for get_react_renders
 * and get_fiber_tree. Idempotent (guard via __argent_profiler_installed__).
 */
export const FIBER_ROOT_TRACKER_SCRIPT = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || hook.__argent_profiler_installed__) return;
  hook.__argent_profiler_installed__ = true;
  hook.__argent_roots__ = new Set();

  var orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function __argent_fiberRootTracker(rendererID, root, priorityLevel) {
    hook.__argent_roots__.add(root);
    if (typeof orig === 'function') orig.call(this, rendererID, root, priorityLevel);
  };
})();
`;

export interface ScriptSourceEntry {
  url: string;
  sourceMapURL: string;
}

export interface ProfilerSessionPaths {
  sessionId: string;
  debugDir: string;
  cpuProfilePath: string | null;
  commitsPath: string | null;
  cpuSampleIndexPath: string | null;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  deviceId: string | null;
  deviceName: string | null;
  appName: string | null;
  projectRoot: string | null;
}

export interface ReactProfilerSessionApi {
  port: number;
  deviceId: string | null;
  cdp: CDPClient;
  projectRoot: string;
  hermesVersion: string;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  sessionPaths: ProfilerSessionPaths | null;
  profilingActive: boolean;
  scriptSources: Map<string, ScriptSourceEntry>;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  profileStartWallMs: number | null;
  disposeSession: () => void;
}

export const reactProfilerSessionBlueprint: ServiceBlueprint<ReactProfilerSessionApi, string> = {
  namespace: REACT_PROFILER_SESSION_NAMESPACE,

  // payload is either "port" or "port:deviceId"
  getURN(payload: string) {
    return `${REACT_PROFILER_SESSION_NAMESPACE}:${payload}`;
  },

  getDependencies(payload: string) {
    const colonIdx = payload.indexOf(":");
    const portStr = colonIdx >= 0 ? payload.slice(0, colonIdx) : payload;
    const deviceId = colonIdx >= 0 ? payload.slice(colonIdx + 1) : undefined;
    const depPayload = deviceId ? `${portStr}:${deviceId}` : portStr;
    return { debugger: `JsRuntimeDebugger:${depPayload}` };
  },

  async factory(deps, _payload) {
    const debuggerApi = deps.debugger as JsRuntimeDebuggerApi;
    const cdp = debuggerApi.cdp;
    const port = debuggerApi.port;
    const ignore = () => {};
    const warnOnError = (label: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ReactProfilerSession:${port}] ${label} failed (non-fatal): ${msg}\n`);
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    const state: ReactProfilerSessionApi = {
      port: debuggerApi.port,
      deviceId: debuggerApi.logicalDeviceId ?? null,
      cdp,
      projectRoot: debuggerApi.projectRoot,
      hermesVersion: "unknown",
      detectedArchitecture: null,
      sessionPaths: null,
      profilingActive: false,
      scriptSources: new Map<string, ScriptSourceEntry>(),
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
      profileStartWallMs: null,
      disposeSession: () => events.emit("terminated"),
    };

    // Enable Profiler domain
    await cdp.send("Profiler.enable").catch(warnOnError("Profiler.enable"));

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
    await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(warnOnError("FIBER_ROOT_TRACKER_SCRIPT"));

    // Detect RN architecture
    try {
      const archJson = (await cdp.evaluate(
        `JSON.stringify({
          bridgeless: typeof globalThis.RN$Bridgeless !== 'undefined' ? !!globalThis.RN$Bridgeless : null,
          turboModules: typeof globalThis.__turboModuleProxy !== 'undefined',
          fabric: typeof globalThis.nativeFabricUIManager !== 'undefined'
        })`
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
    } catch (err) {
      warnOnError("architecture detection")(err);
    }

    // Get Hermes version
    try {
      const propsJson = (await cdp.evaluate(
        "JSON.stringify(HermesInternal.getRuntimeProperties())"
      )) as string | undefined;

      if (propsJson) {
        const props = JSON.parse(propsJson) as Record<string, unknown>;
        state.hermesVersion = (props["OSS Release Version"] as string) ?? "unknown";
      }
    } catch (err) {
      warnOnError("Hermes version probe")(err);
    }

    cdp.events.on("disconnected", (error) => {
      // Only clear cache if profiling was in progress — preserves data from a completed session
      // that survived app restart, while preventing stale in-flight data from being returned.
      if (state.profilingActive) {
        clearCachedProfilerPaths(state.port, state.deviceId ?? undefined);
      }
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api: state,
      dispose: async () => {
        // Profiler.stop is called explicitly in react-profiler-stop before disposal.
        await cdp.send("Profiler.disable").catch(ignore);
      },
      events,
    };
  },
};

const profilerPathsCache = new Map<string, ProfilerSessionPaths>();

function cacheKey(port: number, deviceId?: string): string {
  return deviceId ? `${port}:${deviceId}` : `${port}`;
}

export function cacheProfilerPaths(
  port: number,
  paths: ProfilerSessionPaths,
  deviceId?: string
): void {
  profilerPathsCache.set(cacheKey(port, deviceId), paths);
}

export function getCachedProfilerPaths(
  port: number,
  deviceId?: string
): ProfilerSessionPaths | undefined {
  return profilerPathsCache.get(cacheKey(port, deviceId));
}

export function clearCachedProfilerPaths(port: number, deviceId?: string): void {
  profilerPathsCache.delete(cacheKey(port, deviceId));
}

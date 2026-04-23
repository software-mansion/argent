import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { JsRuntimeDebuggerApi } from "./js-runtime-debugger";

export const REACT_PROFILER_SESSION_NAMESPACE = "ReactProfilerSession";

/**
 * Injected once on connect — tracks fiber root commits for get_react_renders
 * and get_fiber_tree. Idempotent (guard via __argent_profiler_installed__).
 *
 * Also populates `globalThis.__argent_fiberNames__` with a commit-time
 * fiberID → displayName cache. This is the only reliable way to recover
 * names for transient components (modals, popovers, navigation screens)
 * that unmount between the profiled interaction and `STOP_AND_READ_SCRIPT`:
 * once a fiber is unmounted the DevTools backend drops it from
 * `idToDevToolsInstanceMap`, so `getDisplayNameForElementID` returns null
 * at stop time. Reading the name right after React's own
 * `handleCommitFiberRoot` runs (synchronous inside `orig.call`) guarantees
 * the fiber is still present. Fiber IDs are monotonically increasing and
 * never reused within a renderer, so cache entries never go stale.
 */
export const FIBER_ROOT_TRACKER_SCRIPT = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || hook.__argent_profiler_installed__) return;
  hook.__argent_profiler_installed__ = true;
  hook.__argent_roots__ = new Set();

  if (!globalThis.__argent_fiberNames__) {
    globalThis.__argent_fiberNames__ = Object.create(null);
  }

  var orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function __argent_fiberRootTracker(rendererID, root, priorityLevel) {
    hook.__argent_roots__.add(root);
    if (typeof orig === 'function') orig.call(this, rendererID, root, priorityLevel);

    // Populate fiberID → displayName cache for every fiber that rendered in
    // this commit. Must run AFTER orig.call() — the DevTools backend writes
    // commitData synchronously inside handleCommitFiberRoot, so by the time
    // control returns here getProfilingData() already reflects this commit.
    try {
      var ri = hook.rendererInterfaces && hook.rendererInterfaces.get(rendererID);
      if (!ri || ri.__argent_isProfiling__ !== true) return;

      var pd = ri.getProfilingData ? ri.getProfilingData() : null;
      if (!pd || !pd.dataForRoots) return;

      var cache = globalThis.__argent_fiberNames__;
      for (var r = 0; r < pd.dataForRoots.length; r++) {
        var commitData = pd.dataForRoots[r].commitData;
        if (!commitData || commitData.length === 0) continue;
        var latest = commitData[commitData.length - 1];
        var fa = latest.fiberActualDurations || [];
        for (var k = 0; k < fa.length; k++) {
          var entry = fa[k];
          if (!entry) continue;
          var fiberID = entry[0];
          if (cache[fiberID] !== undefined) continue;
          try {
            var name = ri.getDisplayNameForElementID(fiberID);
            if (typeof name === 'string' && name.length > 0) {
              cache[fiberID] = name;
            }
          } catch (_e) {}
        }
      }
    } catch (_e) {
      // Swallow — a bug in the cache path must never disrupt React rendering.
    }
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
}

export interface ReactProfilerSessionApi {
  port: number;
  deviceId: string;
  cdp: CDPClient;
  projectRoot: string;
  appName: string;
  deviceName: string;
  hermesVersion: string;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  sessionPaths: ProfilerSessionPaths | null;
  profilingActive: boolean;
  scriptSources: Map<string, ScriptSourceEntry>;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  profileStartWallMs: number | null;
  sessionId: string | null;          // mirrors __ARGENT_PROFILER_OWNER__.sessionId when we own; null otherwise
  ownerToolServerPid: number | null; // process.pid when this tool-server owns; null otherwise
  disposeSession: () => void;
}

export const reactProfilerSessionBlueprint: ServiceBlueprint<ReactProfilerSessionApi, string> = {
  namespace: REACT_PROFILER_SESSION_NAMESPACE,

  getURN(payload: string) {
    return `${REACT_PROFILER_SESSION_NAMESPACE}:${payload}`;
  },

  getDependencies(payload: string) {
    return { debugger: `JsRuntimeDebugger:${payload}` };
  },

  async factory(deps, payload) {
    const debuggerApi = deps.debugger as JsRuntimeDebuggerApi;
    const cdp = debuggerApi.cdp;
    const port = debuggerApi.port;
    const colonIdx = payload.indexOf(":");
    if (colonIdx < 0) {
      throw new Error(`ReactProfilerSession payload must be "port:deviceId", got: "${payload}"`);
    }
    const deviceId = payload.slice(colonIdx + 1);
    if (!deviceId) {
      throw new Error(`ReactProfilerSession payload missing deviceId: "${payload}"`);
    }
    const ignore = () => {};
    const warnOnError = (label: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ReactProfilerSession:${port}] ${label} failed (non-fatal): ${msg}\n`);
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    const state: ReactProfilerSessionApi = {
      port: debuggerApi.port,
      deviceId,
      cdp,
      projectRoot: debuggerApi.projectRoot,
      appName: debuggerApi.appName,
      deviceName: debuggerApi.deviceName,
      hermesVersion: "unknown",
      detectedArchitecture: null,
      sessionPaths: null,
      profilingActive: false,
      scriptSources: new Map<string, ScriptSourceEntry>(),
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
      profileStartWallMs: null,
      sessionId: null,
      ownerToolServerPid: null,
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
        clearCachedProfilerPaths(state.port, state.deviceId);
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

function cacheKey(port: number, deviceId: string): string {
  return `${port}:${deviceId}`;
}

export function cacheProfilerPaths(
  port: number,
  paths: ProfilerSessionPaths,
  deviceId: string
): void {
  profilerPathsCache.set(cacheKey(port, deviceId), paths);
}

export function getCachedProfilerPaths(
  port: number,
  deviceId: string
): ProfilerSessionPaths | undefined {
  return profilerPathsCache.get(cacheKey(port, deviceId));
}

export function clearCachedProfilerPaths(port: number, deviceId: string): void {
  profilerPathsCache.delete(cacheKey(port, deviceId));
}

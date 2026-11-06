import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { deviceIdsOf } from "../utils/debugger/device-alias";
import { assertExternalCapability } from "../utils/external-devices";
import type { CDPClient, ScriptInfo } from "../utils/debugger/cdp-client";
import type { JsRuntimeDebuggerApi, RuntimeAppMetadata } from "./js-runtime-debugger";
import {
  FIBER_ROOT_TRACKER_SCRIPT,
  STOP_FOR_TAKEOVER_SCRIPT,
} from "../utils/react-profiler/scripts";
import { readTakeover } from "../utils/react-profiler/session-ownership";

export const REACT_PROFILER_SESSION_NAMESPACE = "ReactProfilerSession";

interface ScriptSourceEntry {
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
  /** Set by profiler-load: this session came from disk, not from a run on this tool-server. */
  loadedFromDisk?: boolean;
}

export interface ReactProfilerSessionApi {
  port: number;
  deviceId: string;
  cdp: CDPClient;
  projectRoot: string;
  appName: string;
  deviceName: string;
  runtimeApp?: RuntimeAppMetadata;
  hermesVersion: string;
  detectedArchitecture: "bridge" | "bridgeless" | null;
  sessionPaths: ProfilerSessionPaths | null;
  profilingActive: boolean;
  /** Set for as long as a react-profiler-stop is collecting the run. */
  stopping: boolean;
  scriptSources: Map<string, ScriptSourceEntry>;
  anyCompilerOptimized: boolean | null;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
  profileStartWallMs: number | null;
  sessionId: string | null; // mirrors __ARGENT_PROFILER_OWNER__.sessionId while we own the run
  ownerToolServerPid: number | null; // process.pid while this tool-server owns the run
  /** Set by the teardown, so a start that was awaiting the app knows its session is gone. */
  disposed: boolean;
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
      throw new FailureError(
        `ReactProfilerSession payload must be "port:deviceId", got: "${payload}"`,
        {
          error_code: FAILURE_CODES.REACT_PROFILER_SESSION_PAYLOAD_INVALID,
          failure_stage: "react_profiler_session_payload",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const deviceId = payload.slice(colonIdx + 1);
    if (!deviceId) {
      throw new FailureError(`ReactProfilerSession payload missing deviceId: "${payload}"`, {
        error_code: FAILURE_CODES.REACT_PROFILER_SESSION_PAYLOAD_DEVICE_MISSING,
        failure_stage: "react_profiler_session_payload",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    /**
     * The React profiler rides the same CDP session as the JS debugger, so it
     * is gated by the same mechanism. `JsRuntimeDebugger` is a declared
     * dependency and has already checked this. Repeating it here keeps the
     * gate visible at the blueprint that owns the tools rather than relying on
     * a dependency edge staying in place. A no-op for Argent's own devices.
     */
    await assertExternalCapability(REACT_PROFILER_SESSION_NAMESPACE, deviceId, "js-debugger");

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
      runtimeApp: debuggerApi.runtimeApp,
      hermesVersion: "unknown",
      detectedArchitecture: null,
      sessionPaths: null,
      profilingActive: false,
      stopping: false,
      scriptSources: new Map<string, ScriptSourceEntry>(),
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
      profileStartWallMs: null,
      sessionId: null,
      ownerToolServerPid: null,
      disposed: false,
      disposeSession: () => events.emit("terminated"),
    };

    await cdp.send("Profiler.enable").catch(warnOnError("Profiler.enable"));

    const onScriptParsed = (script: ScriptInfo) => {
      if (script.sourceMapURL) {
        state.scriptSources.set(script.scriptId, {
          url: script.url,
          sourceMapURL: script.sourceMapURL,
        });
      }
    };
    cdp.events.on("scriptParsed", onScriptParsed);

    // Idempotent — guarded in JS
    await cdp.evaluate(FIBER_ROOT_TRACKER_SCRIPT).catch(warnOnError("FIBER_ROOT_TRACKER_SCRIPT"));

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

    const onDisconnected = (error?: Error) => {
      // Clear only mid-run, so a completed session's cached paths survive the disconnect.
      if (state.profilingActive) {
        clearCachedProfilerPaths(state.port, state.deviceId);
      }
      events.emit(
        "terminated",
        error ??
          new FailureError("CDP disconnected", {
            error_code: FAILURE_CODES.REACT_PROFILER_SESSION_CDP_DISCONNECTED,
            failure_stage: "react_profiler_session_cdp_lifecycle",
            failure_area: "tool_server",
            error_kind: "network",
          })
      );
    };
    cdp.events.on("disconnected", onDisconnected);

    // A JS reload (`debugger-reload-metro`, `r` in Metro, a red-box Reload)
    // ends the run inside the app, and everything this session set up there.
    // A page with React Native's `nativePageReloads` capability keeps this CDP
    // connection open across the reload, so `disconnected` never fires: the
    // runtime only reports its execution context gone. End the session here
    // instead, so its run stops counting as a profile (profiling-devices.ts)
    // and the next start sets up the new runtime.
    let runtimeReloaded = false;
    const onCdpEvent = (method: string) => {
      if (
        method !== "Runtime.executionContextDestroyed" &&
        method !== "Runtime.executionContextsCleared"
      ) {
        return;
      }
      runtimeReloaded = true;
      if (state.profilingActive || state.stopping) {
        state.profilingActive = false;
        clearCachedProfilerPaths(state.port, state.deviceId);
        recordLostProfilerRun(state, "js_reload");
        stopSamplerInNextRuntime(cdp);
      }
      events.emit("terminated");
    };
    cdp.events.on("event", onCdpEvent);

    return {
      api: state,
      dispose: async () => {
        state.disposed = true;
        // `cdp.events` belongs to the JsRuntimeDebugger dependency and
        // outlives every dispose but its own teardown; `react-profiler-stop`
        // disposes only this node, once per run.
        cdp.events.off("scriptParsed", onScriptParsed);
        cdp.events.off("disconnected", onDisconnected);
        cdp.events.off("event", onCdpEvent);
        // `react-profiler-stop` stops the renderers and the sampler before
        // disposing; a dispose from `stop-all-simulator-servers` arrives
        // mid-run instead, leaving the in-app DevTools backend recording every
        // commit and argent's commit hook re-serializing its buffer on React's
        // commit path, inside the user's app. `Registry._teardown` disposes
        // dependents before their dependency, so the JsRuntimeDebugger is
        // still connected — the last moment anything can reach the app. A
        // `sessionId` with `profilingActive` off is a stop that failed, or one
        // still running: the app can be recording either. After a reload there
        // is nothing left there to stop, and the new runtime may not answer.
        if (!runtimeReloaded && (state.profilingActive || state.sessionId !== null)) {
          state.profilingActive = false;
          const takeover = cdp.isConnected() ? await readTakeover(cdp, state) : undefined;
          if (takeover) {
            // The app's recording is another session's. A recording with no
            // owner record owns no sampler, so the one this run started would
            // run on: see react-profiler-stop.
            recordLostProfilerRun(state, "taken_over", takeover.by);
            if (takeover.by === null) await cdp.send("Profiler.stop").catch(ignore);
          } else {
            // A dropped connection gets here first: the debugger's own listener
            // tears this node down before `onDisconnected` runs, so only the
            // client can still tell a drop from a scoped teardown.
            recordLostProfilerRun(
              state,
              cdp.isConnected() ? "session_torn_down" : "cdp_disconnected"
            );
            await cdp
              .send("Runtime.evaluate", {
                expression: STOP_FOR_TAKEOVER_SCRIPT,
                returnByValue: true,
              })
              .catch(warnOnError("STOP_FOR_TAKEOVER_SCRIPT"));
            // `Profiler.disable` is not documented to end the Hermes sampler
            // `react-profiler-start` started.
            await cdp.send("Profiler.stop").catch(ignore);
          }
        }
        await cdp.send("Profiler.disable").catch(ignore);
      },
      events,
    };
  },
};

/**
 * The Hermes sampler is process-wide: it runs on in the runtime a JS reload
 * creates, and a later `Profiler.start` there keeps its old samples. A
 * `Profiler.stop` sent before that runtime exists is refused, so it goes out
 * when the runtime announces itself. The listener outlives the session that
 * armed it, and no new run can start before it fires: nothing evaluates in a
 * runtime that has not announced itself yet.
 */
function stopSamplerInNextRuntime(cdp: CDPClient): void {
  const onEvent = (method: string) => {
    if (method !== "Runtime.executionContextCreated") return;
    disarm();
    void cdp.send("Profiler.stop").catch(() => {});
  };
  const disarm = () => {
    cdp.events.off("event", onEvent);
    cdp.events.off("disconnected", disarm);
  };
  cdp.events.on("event", onEvent);
  cdp.events.on("disconnected", disarm);
}

// A run is stored under the id its session connected with: the connect id when
// an alias exists at react-profiler-start, the `logicalDeviceId` when the app has
// restarted and none does. Tools can later name the device by either id, with or
// without an alias, so a lookup tries every id the device has now and takes the
// newest run. react-profiler-analyze and react-profiler-cpu-summary pass their
// `device_id` as given; the query tools canonicalize it first.
const profilerPathsCache = new Map<string, { paths: ProfilerSessionPaths; order: number }>();
let storedRuns = 0;

function cacheKey(port: number, deviceId: string): string {
  return `${port}:${deviceId}`;
}

export function cacheProfilerPaths(
  port: number,
  paths: ProfilerSessionPaths,
  deviceId: string
): void {
  storedRuns += 1;
  profilerPathsCache.set(cacheKey(port, deviceId), { paths, order: storedRuns });
}

export function getCachedProfilerPaths(
  port: number,
  deviceId: string
): ProfilerSessionPaths | undefined {
  let newest: { paths: ProfilerSessionPaths; order: number } | undefined;

  for (const id of deviceIdsOf(deviceId)) {
    const stored = profilerPathsCache.get(cacheKey(port, id));
    if (stored && (!newest || stored.order > newest.order)) {
      newest = stored;
    }
  }

  return newest?.paths;
}

export function clearCachedProfilerPaths(port: number, deviceId: string): void {
  for (const id of deviceIdsOf(deviceId)) {
    profilerPathsCache.delete(cacheKey(port, id));
  }
}

/**
 * Why this tool-server's last run on a device ended without being saved:
 * - `js_reload`: a JS reload (Metro's `r`, a red-box Reload, debugger-reload-metro)
 * - `cdp_disconnected`: the debugger connection dropped
 * - `session_torn_down`: the session was disposed mid-run, e.g. by stop-all-simulator-servers
 * - `taken_over`: another session started a run over this one
 * - `stop_failed`: a react-profiler-stop failed partway
 */
export type LostProfilerRunCause =
  "js_reload" | "cdp_disconnected" | "session_torn_down" | "taken_over" | "stop_failed";

export interface LostProfilerRun {
  cause: LostProfilerRunCause;
  /** The run's `__ARGENT_PROFILER_OWNER__.sessionId`, if it had one. */
  sessionId: string | null;
  startedAtEpochMs: number | null;
  lostAtEpochMs: number;
  /** For `taken_over`: the session that replaced the run, when the app named one. */
  takenOverBy?: string | null;
}

/**
 * Lets react-profiler-status and react-profiler-stop tell a lost run apart
 * from one that never started: the session node is gone by then, and so is
 * everything it knew. Per process, like the saved-paths cache above, so a
 * restarted tool-server knows neither. A saved run and a new start clear the
 * entry; a session loaded from disk does not, since it says nothing about the
 * last run.
 *
 * Stored under every id of the device, because the alias between them is gone
 * after a CDP drop or a teardown. `keys` lets either id clear them all.
 */
const lostRuns = new Map<string, { run: LostProfilerRun; keys: string[] }>();

function findLostRun(port: number, deviceId: string) {
  for (const id of deviceIdsOf(deviceId)) {
    const entry = lostRuns.get(cacheKey(port, id));
    if (entry) return entry;
  }
  return undefined;
}

/**
 * The first cause recorded for a run wins: a teardown that follows the loss
 * is not a second, different one.
 */
export function recordLostProfilerRun(
  run: Pick<ReactProfilerSessionApi, "port" | "deviceId" | "sessionId" | "profileStartWallMs">,
  cause: LostProfilerRunCause,
  takenOverBy?: string | null
): void {
  const prior = findLostRun(run.port, run.deviceId)?.run;
  if (prior && prior.sessionId !== null && prior.sessionId === run.sessionId) return;
  clearLostProfilerRun(run.port, run.deviceId);
  const entry = {
    run: {
      cause,
      sessionId: run.sessionId,
      startedAtEpochMs: run.profileStartWallMs,
      lostAtEpochMs: Date.now(),
      ...(takenOverBy !== undefined ? { takenOverBy } : {}),
    },
    keys: deviceIdsOf(run.deviceId).map((id) => cacheKey(run.port, id)),
  };
  for (const key of entry.keys) lostRuns.set(key, entry);
}

export function getLostProfilerRun(port: number, deviceId: string): LostProfilerRun | undefined {
  return findLostRun(port, deviceId)?.run;
}

export function clearLostProfilerRun(port: number, deviceId: string): void {
  for (const key of findLostRun(port, deviceId)?.keys ?? []) lostRuns.delete(key);
}

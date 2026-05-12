import * as crypto from "node:crypto";
import { z } from "zod";
import { type Registry, type ToolDefinition, ServiceState } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  clearCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import { JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../../blueprints/js-runtime-debugger";
import {
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
  READ_STATE_SCRIPT,
  buildStartScript,
  STOP_FOR_TAKEOVER_SCRIPT,
} from "../../../utils/react-profiler/scripts";
import {
  classifyStaleness,
  DEFAULT_STALE_THRESHOLD_MS,
  type ProfilerSessionOwner,
} from "../../../utils/react-profiler/session-ownership";

/**
 * Verbose explanations the operator sees when the runtime is not profileable.
 * Centralised so every tool that detects "this app cannot be profiled" emits
 * the same diagnosis instead of bespoke one-liners.
 */
export const NO_DEVTOOLS_HOOK_ERROR =
  "React DevTools hook (__REACT_DEVTOOLS_GLOBAL_HOOK__) is not present in this app's JavaScript runtime. " +
  "React profiling requires a development build with React DevTools enabled. " +
  "Likely causes: (1) the app is a release/production build — DevTools is stripped to reduce bundle size; " +
  "(2) you connected to the wrong JS runtime; (3) this isn't a React (Native) app. " +
  "Fix: rebuild in debug/dev mode (e.g. `npx react-native run-ios` without --configuration Release; for Expo, run a dev client). " +
  "Once the app is running with DevTools attached, call react-profiler-start again.";

export const NO_RENDERER_INTERFACE_ERROR =
  "React DevTools hook is present but no renderer interface has registered yet. " +
  "Wait for the app to render its first commit (e.g. trigger a navigation or interaction) and call react-profiler-start again. " +
  "If this persists, the runtime may be a non-React JS context — confirm the target device_id is the one running the React app.";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
  sample_interval_us: z.coerce
    .number()
    .int()
    .positive()
    .default(100)
    .describe("CPU sampling interval in microseconds (default 100)"),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Take over an active profiling session even when it is owned by another tool-server and still fresh. Set to true only when you know the prior owner is gone."
    ),
});

type ReadStateResult =
  | { hookExists: false }
  | { hookExists: true; rendererInterfaceFound: false }
  | {
      hookExists: true;
      rendererInterfaceFound: true;
      isRunning: boolean;
      owner: ProfilerSessionOwner | null;
      nowEpochMs: number;
    };

function safeGetState(registry: Registry, urn: string): ServiceState | null {
  try {
    return registry.getServiceState(urn);
  } catch {
    return null;
  }
}

export function createReactProfilerStartTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-start",
    description: `Start CPU profiling + React commit capture on the connected Hermes runtime.
Delegates React commit capture to the in-app React DevTools backend (ri.startProfiling).
If another tool-server already owns the session, returns { already_running: true, owner, stale, how_to_reclaim } without clobbering their data. Pass { force: true } to reclaim a fresh owner's session, but BEFORE OVERTAKING - ask the user for approval first, see relevant skill for guidance.
Before calling this, ask the user if they also want native profiling (native-profiler-start) — recommend running both in parallel for a complete picture.
After starting, ask the user to perform the interaction to profile, then call react-profiler-stop.
Returns { started_at, startedAtEpochMs, hermes_version, detected_architecture } on success, or the already_running payload described above.
Fails if the Hermes runtime is not reachable or the Metro CDP connection cannot be established.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const jsdUrn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${params.port}:${params.device_id}`;
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}:${params.device_id}`;
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
          if (jsdState !== ServiceState.TERMINATING && psState !== ServiceState.TERMINATING) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

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
            "CDP connection not available. The Hermes runtime may still be loading. Call react-profiler-start again."
          );
        }
      }

      const cdp = api.cdp;

      // Inject the native-profiler instrumentation (idempotent).
      await cdp.evaluate(REACT_NATIVE_PROFILER_SETUP_SCRIPT);

      // Rollback for early validation failures. The session is in
      // RUNNING state after resolveService but no CPU sampler or React
      // backend has been started yet — disposing it ensures subsequent
      // react-profiler-stop / react-profiler-analyze calls see a clean
      // "no session" state instead of tripping over a half-initialised
      // session with no live profile data.
      const disposeSessionQuietly = async () => {
        try {
          await registry.disposeService(psUrn);
        } catch {
          /* best-effort — caller cares about the original error */
        }
      };

      // Snapshot backend state so we can decide whether to start, take over, or refuse.
      // Wrap the eval itself: a thrown CDP error must still trigger rollback,
      // otherwise the half-initialised session stays RUNNING and any later
      // react-profiler-stop trips over an unstarted Hermes sampler.
      let stateJson: string | undefined;
      try {
        stateJson = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
      } catch (err) {
        await disposeSessionQuietly();
        throw err;
      }
      if (!stateJson) {
        await disposeSessionQuietly();
        throw new Error(
          "Failed to read React profiler state from runtime (no value returned). " +
            "The Hermes runtime may have disconnected — verify the app is still running in dev mode and the debugger is attached, then retry."
        );
      }
      const state = JSON.parse(stateJson) as ReadStateResult;

      if (!state.hookExists) {
        await disposeSessionQuietly();
        throw new Error(NO_DEVTOOLS_HOOK_ERROR);
      }
      if (!("rendererInterfaceFound" in state) || !state.rendererInterfaceFound) {
        await disposeSessionQuietly();
        throw new Error(NO_RENDERER_INTERFACE_ERROR);
      }

      // If a session is already active, classify it and decide.
      if (state.isRunning) {
        const owner: ProfilerSessionOwner | null = state.owner;
        const staleness = classifyStaleness({
          owner,
          nowEpochMs: state.nowEpochMs,
          staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
        });

        const canTakeOverSilently = staleness.canReclaimWithoutForce || params.force === true;
        if (!canTakeOverSilently) {
          return {
            already_running: true,
            owner,
            age_seconds: staleness.ageSeconds,
            stale: staleness.stale,
            how_to_reclaim:
              'A profiling session is already active. Stop and ask the user whether you should take over the session. To take over and discard the current session, call react-profiler-start again with { force: true }. Details about the current owner are in the `owner` field. If the sessions is marked as "stale", takeover is safe and may be initiated without prompting the user. Inform about possible cause of already running or stale session. When informing the user, warn about caveats of continuing profiling and taking over the old session.',
          };
        }

        // Reclaim path: stop the prior session so we can start cleanly.
        await cdp.evaluate(STOP_FOR_TAKEOVER_SCRIPT).catch(ignore);
      }

      // Defensive: if Hermes thinks it's already sampling CPU, stop before re-starting.
      if (api.profilingActive) {
        await cdp.send("Profiler.stop").catch(ignore);
        api.profilingActive = false;
      }

      const sessionId = crypto.randomUUID();
      const ownerPayload: ProfilerSessionOwner = {
        sessionId,
        // startedAtEpochMs/lastHeartbeatEpochMs set inside the script using
        // the wrapper-captured value to eliminate clock skew.
        startedAtEpochMs: 0,
        lastHeartbeatEpochMs: 0,
      };

      await cdp.send("Profiler.enable").catch(ignore);
      await cdp.send("Profiler.start", { interval: params.sample_interval_us });

      const startJson = (await cdp.evaluate(buildStartScript(JSON.stringify(ownerPayload)))) as
        | string
        | undefined;
      if (!startJson) {
        throw new Error("Failed to start React profiler (no value returned from runtime).");
      }
      const startResult = JSON.parse(startJson) as {
        ok: boolean;
        reason?: string;
        message?: string;
        startedAtEpochMs?: number;
        isProfilingFlagSet?: boolean;
        ownerInstalled?: boolean;
      };

      if (!startResult.ok) {
        // Roll back CPU sampler so we don't leak state.
        await cdp.send("Profiler.stop").catch(ignore);
        throw new Error(
          `React profiler failed to start (${startResult.reason ?? "unknown"}${
            startResult.message ? `: ${startResult.message}` : ""
          })`
        );
      }

      if (startResult.isProfilingFlagSet !== true || startResult.ownerInstalled !== true) {
        await cdp.send("Profiler.stop").catch(ignore);
        throw new Error(
          `React profiler failed to start (post-start verification failed: isProfilingFlagSet=${startResult.isProfilingFlagSet === true}, ownerInstalled=${startResult.ownerInstalled === true})`
        );
      }

      const startedAtEpochMs = startResult.startedAtEpochMs ?? Date.now();

      clearCachedProfilerPaths(api.port, api.deviceId);
      api.sessionPaths = null;
      api.profilingActive = true;
      api.anyCompilerOptimized = null;
      api.hotCommitIndices = null;
      api.totalReactCommits = null;
      api.profileStartWallMs = startedAtEpochMs;
      api.sessionId = sessionId;
      api.ownerToolServerPid = process.pid;

      return {
        started_at: new Date(startedAtEpochMs).toISOString(),
        startedAtEpochMs,
        hermes_version: api.hermesVersion,
        detected_architecture: api.detectedArchitecture,
      };
    },
  };
}

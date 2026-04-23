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

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z.string().describe("iOS Simulator UDID (logicalDeviceId)."),
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
If another tool-server already owns the session, returns { already_running: true, owner, stale, how_to_reclaim } without clobbering their data. Pass { force: true } to reclaim a fresh owner's session.
Before calling this, ask the user if they also want native iOS profiling (ios-profiler-start) — recommend running both in parallel for a complete picture.
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

      // Snapshot backend state so we can decide whether to start, take over, or refuse.
      const stateJson = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
      if (!stateJson) {
        throw new Error("Failed to read React profiler state from runtime (no value returned).");
      }
      const state = JSON.parse(stateJson) as ReadStateResult;

      if (!state.hookExists) {
        throw new Error(
          "__REACT_DEVTOOLS_GLOBAL_HOOK__ not present. React profiling requires a development build of the app."
        );
      }
      if (!("rendererInterfaceFound" in state) || !state.rendererInterfaceFound) {
        throw new Error(
          "No React renderer interface attached yet. Wait for the app to render its first commit and retry."
        );
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
              "A profiling session is already active. To take over and discard the current session, call react-profiler-start again with { force: true }. Details about the current owner are in the `owner` field — if it looks stale (lastHeartbeatEpochMs is old) or has no owner, takeover is safe. Ask the user, whether you should simply continue with ongoing profiling session or reinitialise it with new react-profiler-start. Inform about possible cause of already running or stale session. Inform about caveats of continuing profiling the old session.",
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
        toolServerPid: process.pid,
        toolServerStartedAtEpochMs: Math.floor(Date.now() - process.uptime() * 1000),
        toolName: "react-profiler-start",
        startArgs: {
          sampleIntervalUs: params.sample_interval_us,
        },
        commitCountAtStart: 0,
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

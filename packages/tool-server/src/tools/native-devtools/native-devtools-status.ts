import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  adviseOnUninjectedApp,
  isInjectableBundleId,
  nativeDevtoolsRef,
  buildInitFailedResult,
  precheckNativeDevtools,
  INJECTION_FAILED_RECOVERY,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
  type NativeDevtoolsInitFailedResult,
  type NativeDevtoolsInjectionFailedResult,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app to check (e.g. com.example.MyApp)"),
});

type Params = z.infer<typeof zodSchema>;
type Result =
  | NativeDevtoolsInitFailedResult
  | NativeDevtoolsInjectionFailedResult
  | {
      envSetup: boolean;
      appRunning: boolean;
      connected: boolean;
      requiresRestart: boolean;
      /** Omitted for a non-injectable app: `injectable: false` is terminal on its own. */
      state?: NativeDevtoolsAppState;
      /**
       * The remedy for `state`, omitted when connected or non-injectable. The
       * booleans alone cannot say "stop restarting the app", which is all an
       * `indeterminate` app needs — and the only state a running app reaches on
       * ios-remote, where no process can be inspected.
       */
      message?: string;
      nextLaunchWillBeInjected: boolean;
      injectable: boolean;
    };

/**
 * Whether the simulator's launchd env carries argent's instrumentation.
 *
 * `isEnvSetup()` latches true on the first successful apply and is never
 * cleared, so a simulator whose env has since been wiped keeps reporting a
 * readiness it does not have. A recorded init failure is what contradicts the
 * latch — any later success clears it — but only where something re-applied the
 * env to record it. `appConnectionState` does that on its way to a verdict for
 * an app it finds UNCONNECTED; a connected one answers off the connections map
 * first, and the non-injectable branch runs no env work at all. On those paths
 * the record is whatever some earlier call for another bundle left, nothing
 * re-tests it while this app stays connected, and the live connection is the
 * better evidence: the process reached this endpoint, so the env was in place.
 */
function envSetupReading(api: NativeDevtoolsApi, connected: boolean): boolean {
  return api.isEnvSetup() && (connected || api.getInitFailure() === null);
}

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  interaction: {
    startedMsg: ({ params }) => `Checking native inspection for ${params.bundleId}`,
    completedMsg: ({ params }) => `Checked native inspection for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to check native inspection for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true, device: true }, appleRemote: { simulator: true } },
  // The "injectable is false" recovery sentence inlines NON_INJECTABLE_RECOVERY
  // verbatim: the description must stay a plain literal so scripts/extract-tools.mjs
  // can read it statically for the spidershield scan. The verbatim match is pinned
  // by native-devtools-status.test.ts.
  description: `Check whether native devtools are connected to a specific app and whether the next launch is prepared for injection.
Use when you need to verify native devtools readiness before calling native-full-hierarchy, native-describe-screen, or native-network-logs.

Returns { envSetup, appRunning, connected, requiresRestart, state, message, nextLaunchWillBeInjected, injectable }:
- envSetup: DYLD_INSERT_LIBRARIES is configured in the simulator's launchd environment
- appRunning: the target bundle currently has a running UIKit process on the simulator
- connected: the dylib is active in the current running process for this bundleId
- requiresRestart: the app is already running and a fresh process would reach this simulator's devtools endpoint where the current one does not — it carries no argent injection, was pointed at an earlier tool-server's listener, or could not be inspected to tell. Always false for a non-injectable app, and false when state is unregistered or connecting, where a relaunch cannot help.
- state: why devtools are or aren't live, measured from the running process. "connected"; "not_running"; "stale_process" (the process cannot reach this simulator's devtools endpoint — launched either before argent's instrumentation was in place or against an earlier tool-server's listener — so restart-app fixes it); "unregistered" (the process IS injected and pointed at this simulator's devtools endpoint yet the service never registered it, so restarting the app cannot help); "connecting" (the process IS injected but launched moments ago and is still connecting, so waiting is what helps); "indeterminate" (the process could not be inspected). Omitted when injectable is false, which is terminal on its own.
- message: the remedy for that state, in full. Omitted when connected or non-injectable. Prefer it over inferring one from the booleans — it is the only field that can tell you to stop restarting the app.
- nextLaunchWillBeInjected: if you launch this bundle now, native devtools env setup is already in place (always false for a non-injectable app)
- injectable: whether native devtools can be relied on to inject into this app. Apple system apps (bundle ids under com.apple.) are platform binaries with library validation, so the dylib cannot be counted on to load into them — it has been observed both loading and not loading, depending on the simulator runtime.

Call this before using app-scoped native hierarchy tools or native-network-logs.
If injectable is false: treat this as TERMINAL — injection cannot be relied on for this app, and no relaunch changes which way it goes. Do NOT restart/retry. Use the standard \`describe\` tool (its accessibility path reads the screen without injection) or \`screenshot\` (then interact by coordinate). Do not fall back to the native-devtools feature tools (native-describe-screen, native-find-views, native-full-hierarchy, native-network-logs, native-view-at-point, native-user-interactable-view-at-point) — they run the same injection precheck and fail with the same non-injectable error.
If appRunning is false and nextLaunchWillBeInjected is true: use launch-app normally.
If requiresRestart is true: call restart-app once, then proceed with the native feature. Read state before acting on a second such reading — indeterminate reaches this rule too, and its line below bounds it at that one restart.
If state is unregistered: do NOT restart the app again — it already launched under the terms a restart would recreate. Restart the tool-server (\`argent server stop && argent server start --detach\`), then retry. If it reads unregistered again after that restart, stop: the process loads argent's dylib but never dials, and no further restart on either side changes it — treat native devtools as unavailable, then use \`describe\` or \`screenshot\` and drive by coordinate.
If state is connecting: do NOT restart the app — launching it is what starts the connection, so a relaunch discards the one in progress and returns this same state. Wait a few seconds and repeat this call.
If state is indeterminate: the process could not be inspected, so restart-app is worth one attempt. If this call still reports it after that restart, do NOT restart the app again — the service is stale rather than the app uninjected, so restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. Remote simulators can never inspect the process, so this is the only unconnected state a running app reaches there.
Returns { status: "init_failed", message, attempts } instead when the simulator's native-devtools environment failed to initialize.
Returns { status: "injection_failed", message } instead once this app has been told to restart, has done so, and the fresh process still never connected — the dylib reaches the process but nothing ever dials. This is a TERMINAL state: do NOT restart the app again and do NOT restart the tool-server, read the message for the likely cause and use \`describe\` or \`screenshot\` instead.
Fails if the simulator server is not running for the given UDID.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    // Terminal case first, mirroring precheckNativeDevtools: non-injectable
    // apps (Apple system apps) may never load the dylib no matter how many
    // times they relaunch, and injectability is a static property of the
    // bundle id — so a broken env must not mask this terminal state behind the
    // precheck's init_failed block, whose "re-boot the simulator" guidance can
    // never make a system app injectable. Report a terminal state so agents
    // stop looping restart-app → retry: no restart is required and the next
    // launch will not be injected either. appRunning/connected are still
    // measured and envSetup derived exactly as below, but no env init or
    // re-verify runs for an app that may never inject — so that reading is
    // whatever the last attempt left rather than a fresh one.
    if (!isInjectableBundleId(params.bundleId)) {
      // A system app CAN carry the injection on some runtimes (#453 saw one
      // way, an E2E run the other), and a live connection is what settles it
      // for this process.
      const connected = api.isConnected(params.bundleId);
      let appRunning: boolean;
      try {
        appRunning = await api.isAppRunning(params.bundleId);
      } catch (err) {
        // The app-running probe (a simctl spawn) failed — typically a sim that
        // is shut down or unreachable, exactly where env init fails too. Prefer
        // the structured init_failed guidance (re-booting IS corrective for a
        // dead sim) over a raw subprocess error. The recorded failure is all
        // there is to consult: this branch runs no env work of its own, so a sim
        // that died after the construction-time latch records nothing and the
        // probe's own error is the honest answer.
        const failure = api.getInitFailure();
        if (failure) return buildInitFailedResult(params.udid, failure);
        throw err;
      }
      return {
        envSetup: envSetupReading(api, connected),
        appRunning,
        connected,
        requiresRestart: false,
        nextLaunchWillBeInjected: false,
        injectable: false,
      };
    }

    const blocked = await precheckNativeDevtools(api, params.udid);
    if (blocked) return blocked;

    // Diagnoses the connection AND re-applies the launchd env on its way, so an
    // out-of-band reboot that wiped DYLD_INSERT_LIBRARIES is repaired here and
    // the outcome recorded — which is why envSetup / nextLaunchWillBeInjected
    // are read after it rather than off a latch stamped before. Idempotent when
    // correct.
    const measured = await api
      .appConnectionState(params.bundleId)
      .catch(() => "indeterminate" as const);
    const connected = measured === "connected";

    // Running-ness comes out of the same measurement rather than a second
    // `launchctl list`: five of the six states settle it on their own, and a
    // separate probe — taken seconds later, since `appConnectionState`
    // re-verifies the env first — could contradict the state beside it
    // (`appRunning: true` next to `state: "not_running"`). Only `indeterminate`
    // carries no answer, so only it pays for a probe.
    let appRunning: boolean;
    let state = measured;
    if (state === "indeterminate") {
      try {
        appRunning = await api.isAppRunning(params.bundleId);
      } catch (err) {
        // A sim that shut down or went unreachable is both the commonest cause
        // of `indeterminate` and what makes this probe fail, so read the failure
        // `appConnectionState`'s `reverifyEnv` has just recorded — it is cleared
        // on any success, so a non-null one beside a failed probe is a dead sim.
        // Re-running the precheck cannot see it: `ensureEnvReady` succeeded
        // above and latches, so every later call is a no-op that reports
        // nothing. With a healthy env the raw error IS the honest answer.
        const failure = api.getInitFailure();
        if (failure) return buildInitFailedResult(params.udid, failure);
        throw err;
      }
      // The probe answers what `indeterminate` left open. If the app is gone
      // that IS `not_running`; leaving the state alone would pair
      // `appRunning: false` with a message reading "Call restart-app then retry".
      if (!appRunning) state = "not_running";
    } else {
      appRunning = state !== "not_running";
    }
    const envSetup = envSetupReading(api, connected);

    // The remedy for the settled state, and the record of the one hand-out that
    // later readings judge against. Reporting the terminal block in place of the
    // record mirrors init_failed above: the record's whole point is to route the
    // agent to `state`'s remedy, and this is the case where there is none left.
    const advice =
      state === "connected"
        ? null
        : adviseOnUninjectedApp(api, params.bundleId, state, INJECTION_FAILED_RECOVERY);
    if (advice?.terminal) return { status: "injection_failed", message: advice.message };

    return {
      envSetup,
      appRunning,
      connected,
      // Derived from the one state, so it can never disagree with it: a relaunch
      // provably changes nothing for `unregistered`, destroys the handshake for
      // `connecting`, and `not_running` needs a launch. That leaves the two a
      // fresh process fixes — `indeterminate` among them, since an uninspectable
      // host (ios-remote) supports no finer reading. Both already carry a live
      // process (the settling above rewrote an empty `indeterminate` to
      // `not_running`), so an `appRunning` conjunct would only restate the state.
      requiresRestart: state === "stale_process" || state === "indeterminate",
      state,
      // The booleans cannot express "one restart, then stop" — the shape
      // `indeterminate` needs, and the only one ios-remote can report for a
      // running app. Carrying the same prose as every other consumer keeps that
      // escape off the agent having read this tool's description.
      ...(advice === null ? {} : { message: advice.message }),
      nextLaunchWillBeInjected: envSetup,
      injectable: true,
    };
  },
};

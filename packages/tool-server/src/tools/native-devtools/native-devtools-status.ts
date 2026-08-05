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
      /**
       * Omitted for a non-injectable app: `injectable: false` is terminal on its
       * own, and no connection diagnosis is run for a process that may never
       * load the dylib.
       */
      state?: NativeDevtoolsAppState;
      /**
       * The remedy for `state`, omitted when connected (or non-injectable,
       * where the description's terminal guidance applies). The booleans alone
       * cannot say "stop restarting the app" — `requiresRestart: true` is the
       * only signal an `indeterminate` app gives, and on ios-remote, where no
       * process can be inspected, that is the only state a running app reaches.
       */
      message?: string;
      nextLaunchWillBeInjected: boolean;
      injectable: boolean;
    };

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
If requiresRestart is true: call restart-app, then proceed with the native feature.
If state is unregistered: do NOT restart the app again — it already launched under the terms a restart would recreate. Restart the tool-server (\`argent server stop && argent server start --detach\`), then retry.
If state is connecting: do NOT restart the app — launching it is what starts the connection, so a relaunch discards the one in progress and returns this same state. Wait a second or two and repeat this call.
If state is indeterminate: the process could not be inspected, so restart-app is worth one attempt. If this call still reports it after that restart, do NOT restart the app again — the service is stale rather than the app uninjected, so restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. Remote simulators can never inspect the process, so this is the only unconnected state a running app reaches there.
Returns { status: "init_failed", message, attempts } instead when the simulator's native-devtools environment failed to initialize.
Returns { status: "injection_failed", message } instead once this app has been told to restart, has done so, and the fresh process still never connected — the dylib is being inserted but dyld is not loading it. This is a TERMINAL state: do NOT restart the app again, read the message for the likely cause and use \`describe\` or \`screenshot\` instead.
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
    // measured and envSetup is derived exactly as it is below — unlike the
    // injectable path, though, there is no point running the precheck's env
    // init or reverifying the env for an app that may never inject, so the
    // reading is whatever the last attempt left rather than a fresh one.
    if (!isInjectableBundleId(params.bundleId)) {
      let appRunning: boolean;
      try {
        appRunning = await api.isAppRunning(params.bundleId);
      } catch (err) {
        // The app-running probe (a simctl spawn) failed — typically a sim that
        // is shut down or unreachable, exactly where env init fails too. Reach
        // for the structured init_failed guidance (re-booting IS corrective for
        // a dead sim) rather than a raw subprocess error. The recorded failure
        // is the whole of that reach: the blueprint attempts the env once at
        // construction, so by now either it succeeded — latching `envSetup`,
        // which makes a precheck here a no-op — or it recorded the failure this
        // reads. A sim that dies after that latch records nothing, since this
        // branch deliberately runs no env work for an app that may never
        // inject; there the probe's own error is all there is to report.
        const failure = api.getInitFailure();
        if (failure) return buildInitFailedResult(params.udid, failure);
        throw err;
      }
      return {
        envSetup: api.isEnvSetup() && api.getInitFailure() === null,
        appRunning,
        connected: api.isConnected(params.bundleId),
        requiresRestart: false,
        nextLaunchWillBeInjected: false,
        injectable: false,
      };
    }

    const blocked = await precheckNativeDevtools(api, params.udid);
    if (blocked) return blocked;

    // Diagnoses the connection AND re-applies the launchd env on its way, so an
    // out-of-band simulator reboot that wiped DYLD_INSERT_LIBRARIES is repaired
    // here and the repair's outcome is recorded. The reported envSetup /
    // nextLaunchWillBeInjected are read after it to reflect that outcome rather
    // than a latch stamped before the call. Idempotent when correct.
    const measured = await api
      .appConnectionState(params.bundleId)
      .catch(() => "indeterminate" as const);
    const connected = measured === "connected";

    // Running-ness comes out of the same measurement rather than a second
    // `launchctl list`. Four of the six states describe a live process and
    // `not_running` IS the absence of one, so five settle running-ness on their
    // own. A separate probe costs an extra simctl round-trip and — because
    // `appConnectionState` re-verifies the env first, putting seconds between
    // the two snapshots — lets the two fields contradict each other, e.g.
    // `appRunning: true` beside `state: "not_running"`. Only `indeterminate`
    // is reported without an answer, so only it pays for its own probe. (Some
    // routes into `indeterminate` did establish running-ness — an unreadable
    // pid row, ios-remote — but the state cannot carry it, so the probe is the
    // only way to get it back, and its answer settles the state below.)
    let appRunning: boolean;
    let state = measured;
    if (state === "indeterminate") {
      try {
        appRunning = await api.isAppRunning(params.bundleId);
      } catch (err) {
        // `indeterminate` is also where a failed measurement lands, and the
        // commonest cause — a sim that shut down or went unreachable — is
        // exactly what makes this probe fail too, so this is the one route to
        // the probe where it has already failed once. Read the recorded failure
        // directly: `appConnectionState`'s `reverifyEnv` has just recorded it
        // and `initFailure` is cleared on any success, so a non-null one means
        // the live env attempt failed, which with a failed running-ness probe
        // beside it is a dead sim. Re-running the precheck here cannot see it —
        // getting this far means the precheck above already drove
        // `ensureEnvReady` to success, and that latches, so every later call is
        // a no-op that reports nothing. Without this read the agent gets the raw
        // subprocess error instead of the structured "re-boot the simulator"
        // guidance; with a healthy env, that raw error IS the honest answer.
        const failure = api.getInitFailure();
        if (failure) return buildInitFailedResult(params.udid, failure);
        throw err;
      }
      // The probe answers the very thing `indeterminate` left open. If the app
      // is gone, that IS `not_running`; leaving the state alone would pair
      // `appRunning: false` with a message reading "Call restart-app then
      // retry", the self-contradiction deriving these from one state prevents.
      if (!appRunning) state = "not_running";
    } else {
      appRunning = state !== "not_running";
    }
    // `isEnvSetup()` alone cannot answer this: it latches true on the first
    // successful apply and is never cleared, so a simulator whose env has since
    // been wiped keeps reporting a readiness it does not have. The re-apply
    // above is what tests it, and it records a failure that any later success
    // clears — so a recorded failure standing beside the latch is precisely the
    // case where the launchd env is NOT in place, and telling an agent its next
    // launch will be injected there sends it to relaunch into an uninjected
    // process for as long as the sim stays broken.
    const envSetup = api.isEnvSetup() && api.getInitFailure() === null;

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
      // Derived from the one state, so it can never disagree with it. An
      // `unregistered` process is the case where a relaunch provably changes
      // nothing and a `connecting` one the case where it destroys the handshake
      // it would be waiting on; `not_running` needs a launch, not a restart of
      // something that isn't there. That leaves the two states a fresh process
      // actually fixes — `indeterminate` among them, since an uninspectable
      // host (ios-remote) can support no finer reading. Both of those already
      // carry a live process: the settling above rewrites an `indeterminate`
      // whose probe found nothing to `not_running`, so an `appRunning` conjunct
      // here could only restate what the state has said.
      requiresRestart: state === "stale_process" || state === "indeterminate",
      state,
      // The booleans cannot express "one restart, then stop" — the shape
      // `indeterminate` needs, and the only shape ios-remote can ever report
      // for a running app. Carry the same prose every other consumer of this
      // measurement carries, so the escape does not depend on the agent having
      // read this tool's description.
      ...(advice === null ? {} : { message: advice.message }),
      nextLaunchWillBeInjected: envSetup,
      injectable: true,
    };
  },
};

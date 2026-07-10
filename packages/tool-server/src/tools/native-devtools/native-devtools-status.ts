import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  isInjectableBundleId,
  NON_INJECTABLE_RECOVERY,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailedResult,
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
  | {
      envSetup: boolean;
      appRunning: boolean;
      connected: boolean;
      requiresRestart: boolean;
      nextLaunchWillBeInjected: boolean;
      injectable: boolean;
    };

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  capability: { apple: { simulator: true, device: true }, appleRemote: { simulator: true } },
  description: `Check whether native devtools are connected to a specific app and whether the next launch is prepared for injection.
Use when you need to verify native devtools readiness before calling native-full-hierarchy, native-describe-screen, or native-network-logs.

Returns { envSetup, appRunning, connected, requiresRestart, nextLaunchWillBeInjected, injectable }:
- envSetup: DYLD_INSERT_LIBRARIES is configured in the simulator's launchd environment
- appRunning: the target bundle currently has a running UIKit process on the simulator
- connected: the dylib is active in the current running process for this bundleId
- requiresRestart: the app is already running but its current process does not have native devtools injected (always false for a non-injectable app)
- nextLaunchWillBeInjected: if you launch this bundle now, native devtools env setup is already in place (always false for a non-injectable app)
- injectable: whether native devtools can ever be injected into this app. Apple system apps (bundle ids under com.apple.) are platform binaries with library validation, so the dylib can never load into them.

Call this before using app-scoped native hierarchy tools or native-network-logs.
If injectable is false: this is a TERMINAL state — the app can never be injected. Do NOT restart/retry. ${NON_INJECTABLE_RECOVERY}
If appRunning is false and nextLaunchWillBeInjected is true: use launch-app normally.
If requiresRestart is true: call restart-app, then proceed with the native feature.
Returns { status: "init_failed", message, attempts } instead when the simulator's native-devtools environment repeatedly failed to initialize (injectable apps only — a non-injectable app always gets its terminal state).
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
    // apps (Apple system apps) can never load the dylib no matter how many
    // times they relaunch, and injectability is a static property of the
    // bundle id — so a broken env must not mask this terminal state behind the
    // precheck's init_failed block, whose "re-boot the simulator" guidance can
    // never make a system app injectable. Report a terminal state so agents
    // stop looping restart-app → retry: no restart is required and the next
    // launch will not be injected either. appRunning/connected are still
    // measured and envSetup is read from the cached latch — unlike the
    // injectable path below, there is no point running the precheck's env
    // init or reverifying the env for an app that can never inject.
    if (!isInjectableBundleId(params.bundleId)) {
      return {
        envSetup: api.isEnvSetup(),
        appRunning: await api.isAppRunning(params.bundleId),
        connected: api.isConnected(params.bundleId),
        requiresRestart: false,
        nextLaunchWillBeInjected: false,
        injectable: false,
      };
    }

    const blocked = await precheckNativeDevtools(api, params.udid);
    if (blocked) return blocked;

    const appRunning = await api.isAppRunning(params.bundleId);
    const connected = api.isConnected(params.bundleId);

    // When the app isn't connected, the cached env latch can be stale: an
    // out-of-band simulator reboot wipes DYLD_INSERT_LIBRARIES from launchd
    // while isEnvSetup() still reports the stale `true`. Re-apply it so the
    // reported envSetup / nextLaunchWillBeInjected reflect reality — and so a
    // subsequent launch actually gets injected. Idempotent no-op when correct.
    if (!connected) {
      await api.reverifyEnv().catch(() => {});
    }
    const envSetup = api.isEnvSetup();

    return {
      envSetup,
      appRunning,
      connected,
      requiresRestart: appRunning && !connected,
      nextLaunchWillBeInjected: envSetup,
      injectable: true,
    };
  },
};

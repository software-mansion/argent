import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";

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
    };

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  requires: ["xcrun"],
  capability: { apple: { simulator: true, device: true }, appleRemote: { simulator: true } },
  description: `Check whether native devtools are connected to a specific app and whether the next launch is prepared for injection.
Use when you need to verify native devtools readiness before calling native-full-hierarchy, native-describe-screen, or native-network-logs.

Returns { envSetup, appRunning, connected, requiresRestart, nextLaunchWillBeInjected }:
- envSetup: DYLD_INSERT_LIBRARIES is configured in the simulator's launchd environment
- appRunning: the target bundle currently has a running UIKit process on the simulator
- connected: the dylib is active in the current running process for this bundleId
- requiresRestart: the app is already running but its current process does not have native devtools injected
- nextLaunchWillBeInjected: if you launch this bundle now, native devtools env setup is already in place

Call this before using app-scoped native hierarchy tools or native-network-logs.
If appRunning is false and nextLaunchWillBeInjected is true: use launch-app normally.
If requiresRestart is true: call restart-app, then proceed with the native feature.
Fails if the simulator server is not running for the given UDID or the bundleId is not found.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.nativeDevtools as NativeDevtoolsApi;

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
    };
  },
};

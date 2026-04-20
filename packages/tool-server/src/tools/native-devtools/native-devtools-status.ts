import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app to check (e.g. com.example.MyApp)"),
});

type Params = z.infer<typeof zodSchema>;
type Result = {
  envSetup: boolean;
  appRunning: boolean;
  connected: boolean;
  requiresRestart: boolean;
  nextLaunchWillBeInjected: boolean;
};

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  requires: ["xcrun"],
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
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.nativeDevtools as NativeDevtoolsApi;
    await api.ensureEnvReady();
    const appRunning = await api.isAppRunning(params.bundleId);
    const connected = api.isConnected(params.bundleId);
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

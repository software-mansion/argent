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
  connected: boolean;
  requiresRestart: boolean;
};

export const nativeDevtoolsStatusTool: ToolDefinition<Params, Result> = {
  id: "native-devtools-status",
  description: `Check whether native devtools dylibs are injected into a specific running app on the simulator.
Use when you need to verify native devtools readiness before calling native-full-hierarchy or native-network-logs.
Returns { envSetup, connected, requiresRestart } — envSetup indicates DYLD_INSERT_LIBRARIES is configured, connected means the dylib is active in the running process, requiresRestart means the app must be restarted first.
If requiresRestart is true: call restart-app, then proceed with the native feature.
Fails if the simulator server is not running or the bundleId is not found.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.nativeDevtools as NativeDevtoolsApi;
    const requiresRestart = await api.requiresAppRestart(params.bundleId);
    return {
      envSetup: api.isEnvSetup(),
      connected: api.isConnected(params.bundleId),
      requiresRestart,
    };
  },
};

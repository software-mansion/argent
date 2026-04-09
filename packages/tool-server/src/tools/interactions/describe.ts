import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import type { DescribeNode } from "./describe-contract";
import { parseNativeDescribeScreenResult } from "../native-devtools/native-describe-contract";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { adaptNativeDescribeToDescribeResult } from "./describe-native-adapter";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z
    .string()
    .optional()
    .describe(
      "Optional bundle ID override for native app-targeted describe. " +
        "When omitted, describe auto-targets a safe connected app when possible."
    ),
});

async function nativeDescribe(api: NativeDevtoolsApi, bundleId: string): Promise<DescribeNode> {
  if (await api.requiresAppRestart(bundleId)) {
    throw new Error(
      "Native devtools are not injected into the requested app. " +
        "Call restart-app with the same bundleId, then retry describe."
    );
  }

  const result = (await api.queryViewHierarchy(bundleId, "ViewHierarchy.describeScreen", {})) as {
    error?: string;
  };
  if (result.error) {
    throw new Error(result.error);
  }

  const parsed = parseNativeDescribeScreenResult(result);
  return adaptNativeDescribeToDescribeResult(parsed);
}

export const describeTool: ToolDefinition<z.infer<typeof zodSchema>, DescribeNode> = {
  id: "describe",
  description: `Get the iOS accessibility element tree for a native-devtools-connected app on the simulator.
Returns a JSON tree of UI elements with roles, labels, identifiers, values, and
frame coordinates in normalized [0,1] space (fractions of the screen, not pixels)—the same space as tap/swipe/gesture and simulator-server touch input.
Use when you need element coordinates before tapping or to inspect the UI hierarchy of a running app.

If bundleId is omitted, describe auto-targets a safely identifiable connected foreground app.
If bundleId is provided, describe targets that app explicitly.

This tool is app-scoped, not simulator-wide: it does not inspect Home/system UI unless you target a connected app explicitly.
If native devtools are not injected into the target app (message status "restart_required"): call restart-app, then retry.

Use frame.x + frame.width/2 as the tap X coordinate, frame.y + frame.height/2 as tap Y.

For React Native apps, the debugger-component-tree tool is also available and returns React component names with tap coordinates.
Only supported on iOS simulators.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: `NativeDevtools:${params.udid}`,
  }),
  async execute(services, params, _options) {
    const nativeApi = services.nativeDevtools as NativeDevtoolsApi;

    if (params.bundleId) {
      const target = await resolveNativeTargetApp(nativeApi, params.bundleId);
      return nativeDescribe(nativeApi, target.bundleId);
    }

    const target = await resolveNativeTargetApp(nativeApi);
    return nativeDescribe(nativeApi, target.bundleId);
  },
};

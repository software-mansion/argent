import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "View fields to include. Use EXACT names: " +
        "className, frame, hidden, alpha, identifier, label, nativeID, " +
        "userInteractionEnabled, depth, pointer, tag, windowFrame, bounds, " +
        "center, opaque, clipsToBounds, transform, contentMode, " +
        "backgroundColor, tintColor, layerName. " +
        "Defaults to all of the first group when omitted."
    ),
  skipClasses: z
    .array(z.string())
    .optional()
    .describe(
      "Exact UIView class names whose entire subtree should be pruned " +
        '(e.g. ["UIImageView"] to drop image leaf nodes)'
    ),
  skipClassPrefixes: z
    .array(z.string())
    .optional()
    .describe(
      "Class name prefixes to prune entire subtrees. " +
        'For SwiftUI apps use ["_TtGC7SwiftUI"] to drop mangled SwiftUI ' +
        "generic type subtrees while keeping _UIHostingView and UIKit bridges. " +
        'Avoid broad prefixes like "_UI" — they prune useful system views.'
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum recursion depth (default 8). Increase for deeper inspection, " +
        "decrease to reduce output size."
    ),
});

type Params = z.infer<typeof zodSchema>;
type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; windows: unknown[] };

export const nativeFullHierarchyTool: ToolDefinition<Params, Result> = {
  id: "native-full-hierarchy",
  interaction: {
    startedMsg: ({ params }) => `Reading native view hierarchy for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native view hierarchy for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native view hierarchy for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true, device: true }, appleRemote: { simulator: true } },
  description: `Get the complete UIKit view tree for the running app.
WARNING: Output can be extremely large (100KB–500KB+) for complex apps, especially those built with SwiftUI. Prefer native-find-views for targeted queries.
Use skipClasses / skipClassPrefixes to prune SwiftUI internal subtrees and reduce output size. Use the fields param to request only the properties you need.
Use when you need deep layout debugging, finding views with no accessibility labels, or verifying view structure not exposed through the accessibility tree.
Returns { status: "ok", windows } with the full view hierarchy.
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If status is connect_pending: the app is injected and still connecting — do not restart it, wait a second or two and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised — follow the message (re-boot the simulator) rather than retrying this tool. If status is injection_failed: the app was told to restart, did, and the fresh process still never connected — the dylib is being inserted but dyld is not loading it, so this is TERMINAL. Do NOT restart the app or the tool-server again; read the message for the likely cause and use the standard \`describe\` tool or \`screenshot\` instead.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal — never retry it), and the hierarchy query itself can error or time out.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
    if (blocked) return blocked;

    const rpcParams: Record<string, unknown> = {};
    if (params.fields !== undefined) rpcParams.fields = params.fields;
    if (params.skipClasses !== undefined) rpcParams.skipClasses = params.skipClasses;
    if (params.skipClassPrefixes !== undefined)
      rpcParams.skipClassPrefixes = params.skipClassPrefixes;
    if (params.maxDepth !== undefined) rpcParams.maxDepth = params.maxDepth;

    const result = (await api.queryViewHierarchy(
      params.bundleId,
      "ViewHierarchy.getFullHierarchy",
      rpcParams
    )) as { windows?: unknown[] };

    return { status: "ok", windows: result.windows ?? [] };
  },
};

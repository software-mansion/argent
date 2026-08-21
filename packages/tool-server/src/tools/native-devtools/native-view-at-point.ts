import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
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
  x: z
    .number()
    .describe(
      "Raw X coordinate in the app window's native point space. NOT normalized [0,1] tap space."
    ),
  y: z
    .number()
    .describe(
      "Raw Y coordinate in the app window's native point space. NOT normalized [0,1] tap space."
    ),
  includeAncestors: z
    .boolean()
    .optional()
    .describe("Include ancestor chain for the matched view (default true)"),
  includeChildren: z
    .boolean()
    .optional()
    .describe("Include child views for the matched view (default false)"),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "View fields to include. Defaults: pointer, className, tag, frame, " +
        "windowFrame, bounds, hidden, alpha, opaque, clipsToBounds, " +
        "userInteractionEnabled, depth, identifier, label, layerName, nativeID. " +
        "Additional: center, transform, contentMode, backgroundColor, tintColor"
    ),
  skipClasses: z
    .array(z.string())
    .optional()
    .describe("Exact UIView class names whose entire subtree should be pruned"),
  skipClassPrefixes: z
    .array(z.string())
    .optional()
    .describe("Class name prefixes to prune entire subtrees"),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum depth for returned child/ancestor serialization (default 150)"),
});

type Params = z.infer<typeof zodSchema>;
type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; view: unknown | null };

export const nativeViewAtPointTool: ToolDefinition<Params, Result> = {
  id: "native-view-at-point",
  interaction: {
    startedMsg: ({ params }) => `Inspecting native view at (${params.x}, ${params.y})`,
    completedMsg: ({ params }) => `Inspected native view at (${params.x}, ${params.y})`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to inspect native view at (${params.x}, ${params.y}): ${failureSignal.error_code}`,
  },
  // `apple.device: false`: native-devtools injects its dylib with DYLD via
  // `simctl spawn`, which is simulator-only — a signed app on a physical iPhone
  // cannot load it, so the blueprint refuses `kind: "device"` outright. Gate here
  // too so a physical udid is rejected by the capability check with a clear
  // message instead of reaching the blueprint's throw.
  capability: { apple: { simulator: true, device: false }, appleRemote: { simulator: true } },
  description: `Inspect the deepest visible UIView at a raw native window point.

Unlike native-user-interactable-view-at-point, this ignores userInteractionEnabled,
so it answers "what is visually here?" rather than "what would receive the touch?".

Use when a screenshot shows something the accessibility tree does not name — an
unlabeled icon, a decorative overlay, a custom-drawn cell — and you need the class,
identifier or nativeID of whatever draws it.

Returns { status: "ok", view }: the matched view with its class name, frames,
identifier, label and layer name, its ancestor chain by default, and its subviews on
request. view is null when nothing is drawn at that point.

IMPORTANT: x and y are raw iOS window coordinates in points, NOT normalized [0,1]
simulator tap coordinates.

If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting — do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised — follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal — never retry it), and the point query itself can error or time out.`,
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

    const rpcParams: Record<string, unknown> = {
      x: params.x,
      y: params.y,
    };
    if (params.includeAncestors !== undefined) rpcParams.includeAncestors = params.includeAncestors;
    if (params.includeChildren !== undefined) rpcParams.includeChildren = params.includeChildren;
    if (params.fields !== undefined) rpcParams.fields = params.fields;
    if (params.skipClasses !== undefined) rpcParams.skipClasses = params.skipClasses;
    if (params.skipClassPrefixes !== undefined)
      rpcParams.skipClassPrefixes = params.skipClassPrefixes;
    if (params.maxDepth !== undefined) rpcParams.maxDepth = params.maxDepth;

    const result = (await api.queryViewHierarchy(
      params.bundleId,
      "ViewHierarchy.viewAtPoint",
      rpcParams
    )) as { view?: unknown | null; error?: string };

    if (result.error) {
      throw new FailureError(result.error, {
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_VIEW_AT_POINT_ERROR,
        failure_stage: "native_devtools_view_at_point",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }

    return { status: "ok", view: result.view ?? null };
  },
};

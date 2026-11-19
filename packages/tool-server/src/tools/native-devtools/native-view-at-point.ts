import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

export type ViewAtPointResult =
  NativeDevtoolsPrecheckBlock | { status: "ok"; view: unknown | null };

/** The parameters both view-at-point tools take. */
export const viewAtPointParams = {
  ...nativeAppTarget,
  x: z
    .number()
    .describe(
      "Raw X coordinate in points, on the axes of the UI as the user sees it (the axes of screenshots and describe frames)<flag:macos-apps>; on a Mac app, points from the top-left of the area describe reports</flag:macos-apps>. NOT normalized [0,1] tap space."
    ),
  y: z
    .number()
    .describe("Raw Y coordinate in points, on the same axes as x. NOT normalized [0,1] tap space."),
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
        "windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, " +
        "userInteractionEnabled, depth, identifier, label, layerName, nativeID. " +
        "Additional: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder"
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
};

const zodSchema = z.object({
  ...viewAtPointParams,
  hitTest: z
    .boolean()
    .optional()
    .describe(
      "true returns the view that would receive a touch at the point: it respects userInteractionEnabled, close to UIKit hit-testing. Default false: the deepest visible view."
    ),
});

type Params = z.infer<typeof zodSchema>;
type Result = ViewAtPointResult;

/** Send the hit-test query (the view that receives the touch) or the plain one (the view drawn there). */
export function queryViewAtPoint(
  services: Record<string, unknown>,
  params: z.infer<z.ZodObject<typeof viewAtPointParams>>,
  toolId: string,
  hitTest: boolean
): Promise<ViewAtPointResult> {
  return queryViewHierarchyFor(
    services,
    params,
    toolId,
    hitTest ? "ViewHierarchy.userInteractableViewAtPoint" : "ViewHierarchy.viewAtPoint",
    hitTest
      ? FAILURE_CODES.NATIVE_DEVTOOLS_USER_INTERACTABLE_VIEW_AT_POINT_ERROR
      : FAILURE_CODES.NATIVE_DEVTOOLS_VIEW_AT_POINT_ERROR,
    (result: { view?: unknown }) => ({ status: "ok" as const, view: result.view ?? null })
  );
}

export const nativeViewAtPointTool: ToolDefinition<Params, Result> = {
  id: "native-view-at-point",
  description: `Inspect the deepest UIView at a raw native window point: the one drawn there, or with hitTest: true the one that would receive a touch.

Without hitTest it ignores userInteractionEnabled and answers "what is visually here?".
Use when a screenshot shows something the accessibility tree does not name (an
unlabeled icon, a decorative overlay, a custom-drawn cell) and you need the class,
identifier or nativeID of whatever draws it.

With hitTest: true it answers "what would receive the touch?". Use when a tap lands
somewhere unexpected or does nothing, to see which control UIKit would hand the
touch to: a transparent overlay swallowing it, a parent recognizer, a disabled button.

Returns { status: "ok", view }: the matched view with its class name, frames,
identifier, label and layer name, plus its ancestors and subviews as requested.
view is null when nothing is drawn at that point, or with hitTest when no touchable view sits under it.

To get x and y from a normalized describe frame, multiply its values by the
screen size in points, on the same axes (landscape when the UI is).
native-full-hierarchy returns that size as screen (pass maxDepth: 1 and fields: ["className"] to keep it small).<flag:macos-apps> On a Mac app,
multiply them by the size of the area describe reports instead.</flag:macos-apps>

If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
An Apple system app is rejected outright (terminal: never retry it).`,
  zodSchema,
  readOnly: true,
  interaction: {
    startedMsg: ({ params }) =>
      params.hitTest
        ? `Finding interactive view at (${params.x}, ${params.y})`
        : `Inspecting native view at (${params.x}, ${params.y})`,
    completedMsg: ({ params }) =>
      params.hitTest
        ? `Found interactive view at (${params.x}, ${params.y})`
        : `Inspected native view at (${params.x}, ${params.y})`,
    failedMsg: ({ params, failureSignal }) =>
      params.hitTest
        ? `Failed to find interactive view at (${params.x}, ${params.y}): ${failureSignal.error_code}`
        : `Failed to inspect native view at (${params.x}, ${params.y}): ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true },
  },
  services: nativeAppServices,
  execute: (services, { hitTest, ...query }) =>
    queryViewAtPoint(services, query, "native-view-at-point", hitTest === true),
};

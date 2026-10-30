import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

const zodSchema = z.object({
  ...nativeAppTarget,
  x: z
    .number()
    .describe(
      "Raw X coordinate in points, on the portrait axes of the screen (the axes of native-describe-screen frames)<flag:macos-apps>; on a Mac app, points from the top-left of the area describe reports</flag:macos-apps>. NOT normalized [0,1] tap space."
    ),
  y: z
    .number()
    .describe(
      "Raw Y coordinate in points, on the portrait axes of the screen (the axes of native-describe-screen frames)<flag:macos-apps>; on a Mac app, points from the top-left of the area describe reports</flag:macos-apps>. NOT normalized [0,1] tap space."
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
        "windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, " +
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

export const nativeUserInteractableViewAtPointTool: ToolDefinition<Params, Result> = {
  id: "native-user-interactable-view-at-point",
  interaction: {
    startedMsg: ({ params }) => `Finding interactive view at (${params.x}, ${params.y})`,
    completedMsg: ({ params }) => `Found interactive view at (${params.x}, ${params.y})`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to find interactive view at (${params.x}, ${params.y}): ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true },
  },
  description: `Inspect the deepest UIView at a raw native window point that would actually receive touch input.

Unlike native-view-at-point, this respects userInteractionEnabled and is closer to
UIKit hit-testing semantics.

Use when a tap lands somewhere unexpected or does nothing, to see which control
UIKit would hand the touch to: a transparent overlay swallowing it, a parent
recognizer, a disabled button.

Returns { status: "ok", view }: the hit-test winner with its class name, frames,
identifier, label and layer name, its ancestor chain by default, and its subviews on
request. view is null when no touchable view sits under that point.

IMPORTANT: x and y are raw points on the portrait axes of the screen, NOT
normalized [0,1] simulator tap coordinates. To get them from a describe frame,
multiply the normalized values by the screen size in points. Do this also when
the UI is landscape.
<flag:macos-apps>Mac app: x and y are points from the top-left of the area describe reports; returns the view that a click there reaches.
</flag:macos-apps>
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), and the point query itself can error or time out.`,
  readOnly: true,
  zodSchema,
  services: nativeAppServices,
  execute: (services, params) =>
    queryViewHierarchyFor(
      services,
      params,
      "native-user-interactable-view-at-point",
      "ViewHierarchy.userInteractableViewAtPoint",
      FAILURE_CODES.NATIVE_DEVTOOLS_USER_INTERACTABLE_VIEW_AT_POINT_ERROR,
      (result: { view?: unknown }) => ({ status: "ok" as const, view: result.view ?? null })
    ),
};

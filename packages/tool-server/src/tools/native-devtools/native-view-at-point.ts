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
      "Raw X in upright UI points<flag:macos-apps> (Mac app: from describe area top-left)</flag:macos-apps>. Not normalized [0,1]."
    ),
  y: z.number().describe("Raw Y in upright UI points. Not normalized [0,1]."),
  includeAncestors: z.boolean().optional().describe("Include ancestor chain (default true)."),
  includeChildren: z.boolean().optional().describe("Include child views (default false)."),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "View fields to return (defaults: pointer, className, tag, frame, windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, userInteractionEnabled, depth, identifier, label, layerName, nativeID; extra: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder)."
    ),
  skipClasses: z.array(z.string()).optional().describe("Exact UIView class names to prune."),
  skipClassPrefixes: z.array(z.string()).optional().describe("Class name prefixes to prune."),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max serialization depth (default 150)."),
};

const zodSchema = z.object({
  ...viewAtPointParams,
  hitTest: z
    .boolean()
    .optional()
    .describe(
      "true: touch-receiving view (UIKit hit-test). false (default): deepest visible view."
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
  description: `Inspect the deepest drawn UIView at raw point (x, y) by default, or the touch-receiving UIView with \`hitTest: true\`.
Use when debugging unlabeled/custom views not in \`describe\` or checking which view swallows a tap (use \`hitTest: true\`).
Convert normalized \`describe\` coords by multiplying by \`screen\` points from \`native-full-hierarchy\` (\`maxDepth: 1\`)<flag:macos-apps>; on a Mac app, multiply by the area \`describe\` reports</flag:macos-apps>.
Returns \`{ status: "ok", view }\` (null if none).
Status handling: If status is restart_required: follow message (usually restart-app) and retry. If status is service_stale: restart tool-server (\`argent server stop && argent server start --detach\`) and retry; if the same status comes back, stop restarting. If status is connect_pending: Do not restart it, wait a few seconds and retry. If status is init_failed: reboot simulator. An Apple system app is rejected outright (terminal: never retry it).`,
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
    macos: { app: true, catalyst: false },
  },
  services: nativeAppServices,
  execute: (services, { hitTest, ...query }) =>
    queryViewAtPoint(services, query, "native-view-at-point", hitTest === true),
};

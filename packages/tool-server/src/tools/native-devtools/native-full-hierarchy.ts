import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; windows: unknown[]; screen?: unknown };

const zodSchema = z.object({
  ...nativeAppTarget,
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Exact view fields to return (defaults: pointer, className, tag, frame, windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, userInteractionEnabled, depth, identifier, label, layerName, nativeID; extra: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder)."
    ),
  skipClasses: z
    .array(z.string())
    .optional()
    .describe('Exact UIView classes to prune (e.g. ["UIImageView"]).'),
  skipClassPrefixes: z
    .array(z.string())
    .optional()
    .describe('Class prefixes to prune (e.g. ["_TtGC7SwiftUI"] for SwiftUI; avoid broad "_UI").'),
  maxDepth: z.number().int().positive().optional().describe("Max recursion depth (default 8)."),
});

type Params = z.infer<typeof zodSchema>;

export const nativeFullHierarchyTool: ToolDefinition<Params, Result> = {
  id: "native-full-hierarchy",
  description: `Get the complete UIKit view tree for the running app (can be 100KB+; prefer \`native-find-views\` for targeted lookups, or constrain with \`skipClasses\`, \`fields\`, \`maxDepth\`).
Use when debugging layout or inspecting views absent from the accessibility tree.
Returns \`{ status: "ok", windows, screen }\` (\`screen\` gives upright point size and orientation; \`screenFrame\` uses upright UI axes).
<flag:macos-apps>Mac app: returns AppKit window view tree with \`screenFrame\` in points from the \`describe\` area top-left. Statuses below are iOS only.
</flag:macos-apps>If status is restart_required: follow message (usually restart-app) and retry. If status is service_stale: restart tool-server (\`argent server stop && argent server start --detach\`) and retry; if the same status comes back, stop restarting. If status is connect_pending: Do not restart it, wait a few seconds and retry. If status is init_failed: reboot simulator. Fails if an Apple system app is targeted (An Apple system app is rejected outright — terminal, never retry it).`,
  zodSchema,
  readOnly: true,
  interaction: {
    startedMsg: ({ params }) => `Reading native view hierarchy for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native view hierarchy for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native view hierarchy for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true, catalyst: false },
  },
  services: nativeAppServices,
  execute: (services, params) =>
    queryViewHierarchyFor(
      services,
      params,
      "native-full-hierarchy",
      "ViewHierarchy.getFullHierarchy",
      null,
      (result: { windows?: unknown[]; screen?: unknown }) => ({
        status: "ok" as const,
        windows: result.windows ?? [],
        // `screen` is the screen's point size in the UI's upright space, the
        // space every `screenFrame` is in once turned (see
        // `utils/native-devtools-upright.ts`), and the interface orientation;
        // an older injected build reports none.
        ...(result.screen !== undefined ? { screen: result.screen } : {}),
      })
    ),
};

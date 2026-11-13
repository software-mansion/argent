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
      "View fields to include. Use EXACT names. Defaults: pointer, className, tag, frame, " +
        "windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, " +
        "userInteractionEnabled, depth, identifier, label, layerName, nativeID. " +
        "Additional: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder"
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
        'Avoid broad prefixes like "_UI": they prune useful system views.'
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum recursion depth (default 8). Raise it to reach deeper views."),
});

type Params = z.infer<typeof zodSchema>;

export const nativeFullHierarchyTool: ToolDefinition<Params, Result> = {
  id: "native-full-hierarchy",
  description: `Get the complete UIKit view tree for the running app.
WARNING: Output can be extremely large (100KB–500KB+) for complex apps, especially those built with SwiftUI. Prefer native-find-views for targeted queries.
Reduce the output with skipClasses / skipClassPrefixes, fields and maxDepth.
Use when you need deep layout debugging, finding views with no accessibility labels, or verifying view structure not exposed through the accessibility tree.
Returns { status: "ok", windows, screen } with the full view hierarchy. screen gives the screen size in points on its portrait axes, and the interfaceOrientation of the UI (portrait, portraitUpsideDown, landscapeLeft, landscapeRight). Each screenFrame uses the portrait axes of the screen. Each windowFrame uses the axes of its window, which turn with the UI.
<flag:macos-apps>On a Mac app it returns the AppKit view tree of the app's windows, each screenFrame in points from the top-left of the area describe reports. The statuses below are iOS only.
</flag:macos-apps>If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
An Apple system app is rejected outright (terminal: never retry it).`,
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
    macos: { app: true },
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
        // `screen` is the screen's point size in its portrait-native space, the
        // space every `screenFrame` is in, and the interface orientation on it;
        // an older injected build reports none.
        ...(result.screen !== undefined ? { screen: result.screen } : {}),
      })
    ),
};

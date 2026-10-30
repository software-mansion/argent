import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

const zodSchema = z.object({
  ...nativeAppTarget,
  className: z.string().optional().describe("UIView class name to match (exact, e.g. UIButton)"),
  identifier: z.string().optional().describe("Accessibility identifier to match (exact)"),
  label: z.string().optional().describe("Accessibility label to match (exact)"),
  tag: z.number().int().optional().describe("UIView tag integer to match"),
  nativeID: z.string().optional().describe("React Native nativeID prop to match (exact)"),
  includeAncestors: z
    .boolean()
    .optional()
    .describe("Include ancestor chain for each matched view (default true)"),
  includeChildren: z
    .boolean()
    .optional()
    .describe("Include child views for each matched view (default true)"),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "View fields to include. Defaults: className, frame, hidden, alpha, " +
        "identifier, label, nativeID, userInteractionEnabled, depth. " +
        "Additional: pointer, tag, windowFrame, screenFrame, bounds, center, opaque, " +
        "clipsToBounds, transform, contentMode, backgroundColor, tintColor, layerName"
    ),
});

type Params = z.infer<typeof zodSchema>;
type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; matches: unknown[] };

export const nativeFindViewsTool: ToolDefinition<Params, Result> = {
  id: "native-find-views",
  interaction: {
    startedMsg: ({ params }) => `Searching native views in ${params.bundleId}`,
    completedMsg: ({ params, result }) => {
      const count = result.status === "ok" ? result.matches.length : 0;
      return `Found ${count} native ${count === 1 ? "view" : "views"} in ${params.bundleId}`;
    },
    failedMsg: ({ params, failureSignal }) =>
      `Failed to search native views in ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true },
  },
  description: `Search for specific UIViews in the running app by class name, accessibility identifier, label, tag, or React Native nativeID.
Use when you need to locate a specific view by its properties without dumping the entire hierarchy.
Returns { status: "ok", matches } with matching views including their frames, properties, optional ancestors, and optional children. Much more targeted than native-full-hierarchy.
At least one of className, identifier, label, tag, or nativeID must be provided.
<flag:macos-apps>On a Mac app it searches the AppKit views of every visible window (className is the NSView class, identifier matches the view's accessibility identifier or identifier), with the same result shape; the statuses below are iOS only, and on a Mac app that is not running the call fails.
</flag:macos-apps>If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), and the hierarchy query itself can error or time out.`,
  readOnly: true,
  zodSchema,
  services: nativeAppServices,
  execute: (services, params) =>
    queryViewHierarchyFor(
      services,
      params,
      "native-find-views",
      "ViewHierarchy.findViews",
      FAILURE_CODES.NATIVE_DEVTOOLS_FIND_VIEWS_ERROR,
      (result: { matches?: unknown[] }) => ({
        status: "ok" as const,
        matches: result.matches ?? [],
      })
    ),
};

import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; matches: unknown[]; note?: string };

/**
 * The `note` of an empty Mac app result. A SwiftUI control has no NSView that
 * carries its identifier or label, so the library's NSView search cannot find
 * it, while describe, which reads the accessibility tree, lists it.
 */
const MACOS_NO_MATCH_NOTE =
  "No NSView matched. SwiftUI sets a control's identifier and label on an accessibility element, " +
  "not on an NSView, so this search does not find SwiftUI controls: describe lists them with " +
  "their identifiers and frames.";

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
      "View fields to include. Defaults: pointer, className, tag, frame, " +
        "windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, " +
        "userInteractionEnabled, depth, identifier, label, layerName, nativeID. " +
        "Additional: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder"
    ),
});

type Params = z.infer<typeof zodSchema>;

export const nativeFindViewsTool: ToolDefinition<Params, Result> = {
  id: "native-find-views",
  description: `Search for specific UIViews in the running app by class name, accessibility identifier, accessibility label, tag or React Native nativeID; at least one of these params is required.
Use when you need to locate a specific view by its properties without dumping the entire native-full-hierarchy.
Returns { status: "ok", matches }: the matching views with their frames, properties, optional ancestors and optional children. Frames are in points. frame and center are relative to the superview, and windowFrame turns with the UI. To tap a view, divide the centre of its screenFrame by the screen size in points, which native-full-hierarchy returns as screen (maxDepth: 1 is enough), and pass the result to gesture-tap. Matches are not filtered for visibility. Before tapping, call native-user-interactable-view-at-point at that centre with skipClasses ["UITextEffectsWindow"]. If it does not return the match or a descendant, check a screenshot.
<flag:macos-apps>On a Mac app it searches the NSViews of every visible window: className is the NSView class, and identifier matches the accessibility identifier or the view identifier. SwiftUI sets a control's identifier and label on an accessibility element, not on an NSView, so it does not find SwiftUI controls: describe lists them with their identifiers and frames. The tap recipe above and the statuses below are iOS only.
</flag:macos-apps>If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
An Apple system app is rejected outright (terminal: never retry it).`,
  zodSchema,
  readOnly: true,
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
  services: nativeAppServices,
  execute: (services, params) => {
    const onMac = resolveDevice(params.udid).platform === "macos";
    return queryViewHierarchyFor(
      services,
      params,
      "native-find-views",
      "ViewHierarchy.findViews",
      FAILURE_CODES.NATIVE_DEVTOOLS_FIND_VIEWS_ERROR,
      (result: { matches?: unknown[] }) => {
        const matches = result.matches ?? [];
        return {
          status: "ok" as const,
          matches,
          ...(onMac && matches.length === 0 ? { note: MACOS_NO_MATCH_NOTE } : {}),
        };
      }
    );
  },
};

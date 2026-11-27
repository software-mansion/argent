import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";

type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; matches: unknown[]; note?: string };

/**
 * The `note` of an empty Mac app result to an identifier or label search. A
 * SwiftUI control has no NSView that carries its identifier or label, so the
 * library's NSView search cannot find it, while describe, which reads the
 * accessibility tree, lists it. A className search can match the NSView that
 * backs a SwiftUI control, so a className, tag or nativeID miss gets no note.
 */
const MACOS_NO_MATCH_NOTE =
  "No NSView matched. SwiftUI sets a control's identifier and label on an accessibility element, " +
  "not on an NSView, so this search does not find SwiftUI controls: describe lists them with " +
  "their identifiers and frames.";

const zodSchema = z.object({
  ...nativeAppTarget,
  className: z.string().optional().describe("Exact UIView class name (e.g. UIButton)."),
  identifier: z.string().optional().describe("Exact accessibility identifier."),
  label: z.string().optional().describe("Exact accessibility label."),
  tag: z.number().int().optional().describe("UIView integer tag."),
  nativeID: z.string().optional().describe("Exact React Native nativeID."),
  includeAncestors: z.boolean().optional().describe("Include ancestor chain (default true)."),
  includeChildren: z.boolean().optional().describe("Include child views (default true)."),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "View fields to return (defaults: pointer, className, tag, frame, windowFrame, screenFrame, bounds, hidden, alpha, opaque, clipsToBounds, userInteractionEnabled, depth, identifier, label, layerName, nativeID; extra: center, transform, contentMode, backgroundColor, tintColor, value, firstResponder)."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const nativeFindViewsTool: ToolDefinition<Params, Result> = {
  id: "native-find-views",
  description: `Search UIViews by \`className\`, \`identifier\`, \`label\`, \`tag\`, or \`nativeID\` (at least one required).
Use when locating a specific view without dumping \`native-full-hierarchy\`.
Returns \`{ status: "ok", matches }\` (frames in points; \`screenFrame\` uses upright UI axes). Matches are not filtered for visibility: before tapping one, check its \`screenFrame\` center with \`native-view-at-point\` \`hitTest: true\` and \`skipClasses: ["UITextEffectsWindow"]\` (check a screenshot if it returns some other view), then divide that center by \`screen\` from \`native-full-hierarchy\` for \`gesture-tap\`.
<flag:macos-apps>Mac app: searches NSViews across visible windows; an identifier or label search does not find SwiftUI controls: describe lists them with their identifiers and frames. Tap recipe and statuses below are iOS only.
</flag:macos-apps>If status is restart_required: follow message (usually restart-app) and retry. If status is service_stale: restart tool-server (\`argent server stop && argent server start --detach\`) and retry; if the same status comes back, stop restarting. If status is connect_pending: Do not restart it, wait a few seconds and retry. If status is init_failed: reboot simulator. An Apple system app is rejected outright (terminal: never retry it).`,
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
    macos: { app: true, catalyst: false },
  },
  services: nativeAppServices,
  execute: (services, params) => {
    const noteOnEmpty =
      resolveDevice(params.udid).platform === "macos" &&
      (params.identifier !== undefined || params.label !== undefined);
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
          ...(noteOnEmpty && matches.length === 0 ? { note: MACOS_NO_MATCH_NOTE } : {}),
        };
      }
    );
  },
};

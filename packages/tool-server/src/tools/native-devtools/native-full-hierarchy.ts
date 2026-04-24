import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";

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
type Result =
  | { status: "restart_required"; message: string }
  | { status: "ok"; windows: unknown[] };

export const nativeFullHierarchyTool: ToolDefinition<Params, Result> = {
  id: "native-full-hierarchy",
  requires: ["xcrun"],
  description: `Get the complete UIKit view tree for the running app.
WARNING: Output can be extremely large (100KB–500KB+) for complex apps, especially those built with SwiftUI. Prefer native-find-views for targeted queries.
Use skipClasses / skipClassPrefixes to prune SwiftUI internal subtrees and reduce output size. Use the fields param to request only the properties you need.
Use when you need deep layout debugging, finding views with no accessibility labels, or verifying view structure not exposed through the accessibility tree.
Returns { status: "ok", windows } with the full view hierarchy, or { status: "restart_required" } if the dylib is not injected.
Fails if native devtools are not connected or the app is not running.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.nativeDevtools as NativeDevtoolsApi;

    if (await api.requiresAppRestart(params.bundleId)) {
      return {
        status: "restart_required",
        message:
          "Native devtools are not injected into the running app. " +
          "Call restart-app then retry.",
      };
    }

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

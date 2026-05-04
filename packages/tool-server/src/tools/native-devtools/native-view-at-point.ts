import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";

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
type Result =
  | { status: "restart_required"; message: string }
  | { status: "ok"; view: unknown | null };

export const nativeViewAtPointTool: ToolDefinition<Params, Result> = {
  id: "native-view-at-point",
  requires: ["xcrun"],
  description: `Inspect the deepest visible UIView at a raw native window point.

Unlike native-user-interactable-view-at-point, this ignores userInteractionEnabled,
so it answers "what is visually here?" rather than "what would receive the touch?".

IMPORTANT: x and y are raw iOS window coordinates in points, NOT normalized [0,1]
simulator tap coordinates.

If status is restart_required: call restart-app then retry.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
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
      throw new Error(result.error);
    }

    return { status: "ok", view: result.view ?? null };
  },
};

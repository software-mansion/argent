import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  className: z
    .string()
    .optional()
    .describe("UIView class name to match (exact, e.g. UIButton)"),
  identifier: z
    .string()
    .optional()
    .describe("Accessibility identifier to match (exact)"),
  label: z
    .string()
    .optional()
    .describe("Accessibility label to match (exact)"),
  tag: z.number().int().optional().describe("UIView tag integer to match"),
  nativeID: z
    .string()
    .optional()
    .describe("React Native nativeID prop to match (exact)"),
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
        "Additional: pointer, tag, windowFrame, bounds, center, opaque, " +
        "clipsToBounds, transform, contentMode, backgroundColor, tintColor, layerName"
    ),
});

type Params = z.infer<typeof zodSchema>;
type Result =
  | { status: "restart_required"; message: string }
  | { status: "ok"; matches: unknown[] };

export const nativeFindViewsTool: ToolDefinition<Params, Result> = {
  id: "native-find-views",
  description: `Search for specific UIViews in the running app by class name, accessibility identifier, label, tag, or React Native nativeID.

Returns matching views with their frames, properties, optional ancestors, and optional children. Much more targeted than native-full-hierarchy — use this when you know what you're looking for.

At least one of className, identifier, label, tag, or nativeID must be provided.

If status is restart_required: call restart-app then retry.`,
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
    if (params.className !== undefined) rpcParams.className = params.className;
    if (params.identifier !== undefined)
      rpcParams.identifier = params.identifier;
    if (params.label !== undefined) rpcParams.label = params.label;
    if (params.tag !== undefined) rpcParams.tag = params.tag;
    if (params.nativeID !== undefined) rpcParams.nativeID = params.nativeID;
    if (params.includeAncestors !== undefined)
      rpcParams.includeAncestors = params.includeAncestors;
    if (params.includeChildren !== undefined)
      rpcParams.includeChildren = params.includeChildren;
    if (params.fields !== undefined) rpcParams.fields = params.fields;

    const result = (await api.queryViewHierarchy(
      params.bundleId,
      "ViewHierarchy.findViews",
      rpcParams
    )) as { matches?: unknown[]; error?: string };

    if (result.error) {
      throw new Error(result.error);
    }

    return { status: "ok", matches: result.matches ?? [] };
  },
};

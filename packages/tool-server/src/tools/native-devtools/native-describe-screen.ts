import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import {
  parseNativeDescribeScreenResult,
  type NativeDescribeScreenResult,
} from "./native-describe-contract";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  skipClasses: z
    .array(z.string())
    .optional()
    .describe(
      "Exact UIView class names whose entire subtree should be pruned " +
        '(e.g. ["UIImageView"] to drop image-heavy branches)'
    ),
  skipClassPrefixes: z
    .array(z.string())
    .optional()
    .describe(
      "Class name prefixes to prune entire subtrees. " +
        'For SwiftUI apps use ["_TtGC7SwiftUI"] to drop mangled SwiftUI ' +
        "generic type subtrees while keeping UIKit bridges."
    ),
});

type Params = z.infer<typeof zodSchema>;
type Result =
  | { status: "restart_required"; message: string }
  | ({ status: "ok" } & NativeDescribeScreenResult);

export const nativeDescribeScreenTool: ToolDefinition<Params, Result> = {
  id: "native-describe-screen",
  requires: ["xcrun"],
  description: `Read the running app's native accessibility screen description via injected native devtools.

Returns a flat list of accessibility leaf elements with:
- raw native point-space frame and tapPoint
- normalizedFrame and normalizedTapPoint relative to the app's main screen bounds
- top-level screenFrame metadata
- traits and optional labels/identifiers

This is a low-level native inspection tool. The normalized fields are intended to help
with backend migration work, but the public describe contract is still separate.

Useful for evaluating or debugging the lower-level native data that powers the public describe tool.

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

    const rpcParams: Record<string, unknown> = {};
    if (params.skipClasses !== undefined) rpcParams.skipClasses = params.skipClasses;
    if (params.skipClassPrefixes !== undefined)
      rpcParams.skipClassPrefixes = params.skipClassPrefixes;

    const result = (await api.queryViewHierarchy(
      params.bundleId,
      "ViewHierarchy.describeScreen",
      rpcParams
    )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

    if (result.error) {
      throw new Error(result.error);
    }

    const parsed = parseNativeDescribeScreenResult(result);
    return { status: "ok", ...parsed };
  },
};

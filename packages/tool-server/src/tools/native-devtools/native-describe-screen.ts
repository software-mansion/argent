import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
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
type Result = NativeDevtoolsPrecheckBlock | ({ status: "ok" } & NativeDescribeScreenResult);

export const nativeDescribeScreenTool: ToolDefinition<Params, Result> = {
  id: "native-describe-screen",
  interaction: {
    startedMsg: ({ params }) => `Reading native screen for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native screen for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native screen for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true }, appleRemote: { simulator: true } },
  description: `Read the running app's native accessibility screen description via injected native devtools.

Returns a flat list of accessibility leaf elements with:
- raw native point-space frame and tapPoint
- normalizedFrame and normalizedTapPoint relative to the app's main screen bounds
- top-level screenFrame metadata
- traits and optional labels/identifiers

This is a low-level native inspection tool. The normalized fields are intended to help
with backend migration work, but the public describe contract is still separate.

Use when you are evaluating or debugging the lower-level native data behind the public
describe tool, or when you need its raw point-space geometry rather than describe's
normalized contract.

If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting — do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised — follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal — never retry it), and the screen query itself can error or time out.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
    if (blocked) return blocked;

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
      throw new FailureError(result.error, {
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_DESCRIBE_ERROR,
        failure_stage: "native_devtools_describe_screen",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }

    const parsed = parseNativeDescribeScreenResult(result);
    return { status: "ok", ...parsed };
  },
};

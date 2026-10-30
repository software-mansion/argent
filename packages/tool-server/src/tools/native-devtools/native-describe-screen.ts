import { z } from "zod";
import { FAILURE_CODES, type ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsPrecheckBlock } from "../../blueprints/native-devtools";
import { nativeAppServices, nativeAppTarget, queryViewHierarchyFor } from "./macos-view-hierarchy";
import {
  parseNativeDescribeScreenResult,
  type NativeDescribeScreenResult,
} from "./native-describe-contract";

const zodSchema = z.object({
  ...nativeAppTarget,
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
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true },
  },
  description: `Read the running app's native accessibility screen description via injected native devtools.

Returns a flat list of accessibility leaf elements with:
- raw frame and tapPoint in points, on the portrait axes of the screen
- normalizedFrame and normalizedTapPoint on the same axes. gesture-tap uses
  these axes, also when the UI is landscape
- top-level screenFrame metadata: the screen bounds on these axes
- traits and optional labels/identifiers

This is a low-level native inspection tool. The normalized fields are intended to help
with backend migration work, but the public describe contract is still separate.

Use when you are evaluating or debugging the lower-level native data behind the public
describe tool, or when you need its raw point-space geometry rather than describe's
normalized contract.

<flag:macos-apps>On a Mac app it reads the app's own accessibility tree, plus the views with an
identifier that the tree does not contain: the same result shape, with frames in points from the
top-left of the area describe reports (the app window, grown to hold sheets, alerts and menus past
it), screenFrame that area, and normalized values as fractions of it, the space gesture-tap uses
there. skipClasses and skipClassPrefixes are refused there. The statuses below are iOS only; on a Mac app that is not running the call fails.

</flag:macos-apps>If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), and the screen query itself can error or time out.`,
  readOnly: true,
  zodSchema,
  services: nativeAppServices,
  execute: (services, params) =>
    queryViewHierarchyFor(
      services,
      params,
      "native-describe-screen",
      "ViewHierarchy.describeScreen",
      FAILURE_CODES.NATIVE_DEVTOOLS_DESCRIBE_ERROR,
      (result) => ({ status: "ok" as const, ...parseNativeDescribeScreenResult(result) })
    ),
};

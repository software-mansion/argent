import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { nativeAppServices } from "./macos-view-hierarchy";
import {
  queryViewAtPoint,
  viewAtPointParams,
  type ViewAtPointResult,
} from "./native-view-at-point";

const zodSchema = z.object(viewAtPointParams);

type Params = z.infer<typeof zodSchema>;

/**
 * The hit-test query under its own id, for the SDK, `argent run` and saved e2e
 * steps. Agents get it as `native-view-at-point` with `hitTest: true`.
 */
export const nativeUserInteractableViewAtPointTool: ToolDefinition<Params, ViewAtPointResult> = {
  id: "native-user-interactable-view-at-point",
  description: `Inspect the deepest UIView at a raw native window point that would actually receive touch input.

It respects userInteractionEnabled and is close to UIKit hit-testing. The same query as native-view-at-point with hitTest: true, which documents the coordinates and the result.

If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
An Apple system app is rejected outright (terminal: never retry it).`,
  zodSchema,
  hideFromMcp: true,
  readOnly: true,
  interaction: {
    startedMsg: ({ params }) => `Finding interactive view at (${params.x}, ${params.y})`,
    completedMsg: ({ params }) => `Found interactive view at (${params.x}, ${params.y})`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to find interactive view at (${params.x}, ${params.y}): ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true, catalyst: false },
  },
  services: nativeAppServices,
  execute: (services, params) =>
    queryViewAtPoint(services, params, "native-user-interactable-view-at-point", true),
};

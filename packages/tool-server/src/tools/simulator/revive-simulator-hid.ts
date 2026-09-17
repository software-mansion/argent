import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { ToolDefinition } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { reviveHidServices } from "../../utils/hid-suppression";

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target iOS simulator UDID (from `list-devices`) whose HID services to rebuild."),
});

type Params = { udid: string };
type Result = { revived: boolean; udid: string; flagWasSet: boolean | null };

export function createReviveSimulatorHidTool(): ToolDefinition<Params, Result> {
  return {
    id: "revive-simulator-hid",
    interaction: {
      startedMsg: ({ params }) => `Rebuilding HID services on ${params.udid}`,
      completedMsg: ({ params }) => `Rebuilt HID services on ${params.udid}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to rebuild HID services on ${params.udid}: ${failureSignal.error_code}`,
    },
    description:
      "Rebuild an iOS simulator's HID services after CoreDevice tore them down, so taps, hardware buttons and typed text land again.\n" +
      "Use when input is silently dropped: the interaction tools report success (`{ typed, keys }`, `{ pressed }`) but nothing reaches the app, and `describe` shows the field unchanged. `boot-device` already warms the services up before boot, but that is a race the host loses on runtimes newer than iOS 18.6 — this is the repair for a window that has already closed.\n" +
      "DISRUPTIVE: it kills the foreground app and restarts SpringBoard. Relaunch the app under test afterwards (`launch-app` / `restart-app`) and expect to redo any in-app state. That is why it is an explicit call and not part of booting.\n" +
      "Returns { revived, udid, flagWasSet } — `flagWasSet` reports the suppression flag as read inside the guest before the repair, or null when it could not be read. iOS simulators only.",
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const { udid } = params as Params;
      // `notifyutil` and `backboardd` exist only inside an iOS simulator. A
      // physical iPhone has no `simctl spawn`, and an Android serial or a
      // Chromium id would fail deep inside `simctlSpawn` with an unrelated
      // error — reject up front with the reason instead.
      const device = resolveDevice(udid);
      const isSimulator =
        (device.platform === "ios" || device.platform === "ios-remote") &&
        device.kind === "simulator";
      if (!isSimulator) {
        throw new InvalidToolInputError(
          `revive-simulator-hid only applies to an iOS simulator; ${udid} is ` +
            `${device.platform} (${device.kind}). The CoreDevice HID teardown it ` +
            `repairs happens only inside a simulator's backboardd.`,
          {
            error_code: FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION,
            failure_stage: "revive_hid_platform_guard",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
      const { flagWasSet } = await reviveHidServices(udid);
      return { revived: true, udid, flagWasSet };
    },
  };
}

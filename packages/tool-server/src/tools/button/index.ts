import { z } from "zod";
import type { Platform, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

type Params = z.infer<typeof zodSchema>;

export interface Result {
  pressed: string;
}

/**
 * Hardware buttons that physically exist per platform. The zod enum is the
 * union of both platforms' buttons (a flat enum can't express the dependency),
 * so we refine here: iOS has no `back`, Android has no `actionButton`.
 *
 * Rejecting at the tool layer is required because the simulator-server
 * transport is fire-and-forget (see `sendCommand`) and cannot report a backend
 * rejection — an unsupported button would otherwise be a silent no-op that the
 * tool still reports as a successful `{ pressed }`.
 */
const BUTTONS_BY_PLATFORM: Record<Platform, ReadonlySet<Params["button"]>> = {
  ios: new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  android: new Set(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]),
};

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const buttonTool: ToolDefinition<Params, Result> = {
  id: "button",
  description: `Press a device hardware button (iOS simulator or Android emulator). Sends Down then Up events automatically.
Supported buttons depend on the platform: home, back, power, volumeUp, volumeDown, appSwitch, actionButton — buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android) are rejected with a clear error.
Use when you need to trigger hardware button events.
Returns { pressed: buttonName }.
Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (!BUTTONS_BY_PLATFORM[device.platform].has(params.button)) {
      throw new UnsupportedOperationError(
        "button",
        device,
        `button '${params.button}' is not available on ${device.platform}`
      );
    }
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, {
      cmd: "button",
      direction: "Down",
      button: params.button,
    });
    await sleep(50);
    sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
    return { pressed: params.button };
  },
};

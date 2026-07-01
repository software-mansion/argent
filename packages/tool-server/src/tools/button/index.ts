import { z } from "zod";
import type { Platform, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { coreDeviceRef, type CoreDeviceApi } from "../../blueprints/core-device";
import { resolveDevice, isPhysicalIos } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";

// Argent button name → pymobiledevice3 CoreDevice HID button name. CoreDevice
// exposes the physical buttons only; appSwitch (a SpringBoard gesture) and the
// iPhone 15 Pro action button have no HID equivalent, so they are omitted and
// rejected with a clear error on physical iOS.
const COREDEVICE_BUTTON: Partial<Record<Params["button"], string>> = {
  home: "home",
  power: "lock",
  volumeUp: "volume-up",
  volumeDown: "volume-down",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
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
  // Chromium apps have no hardware buttons; the capability gate already
  // excludes them, the empty set keeps the lookup total if one slips through.
  chromium: new Set([]),
  // Vega is remote-driven: hardware buttons / D-pad go through the dedicated
  // `tv-remote` tool, and this tool's capability omits `vega` so a Vega device is
  // rejected before this map is consulted. Empty set keeps the record total.
  vega: new Set(),
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
On a physical iPhone, button presses route over CoreDevice (home, power, volumeUp, volumeDown).
Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (isPhysicalIos(device)) {
      // A button with no CoreDevice HID equivalent (appSwitch/actionButton) is
      // always rejected by execute() below, before it ever touches
      // services.coreDevice — don't pay for resolving the CoreDevice service
      // (tunnel setup, possibly a macOS admin prompt) just to reject anyway.
      if (!COREDEVICE_BUTTON[params.button]) return {};
      return { coreDevice: coreDeviceRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (!BUTTONS_BY_PLATFORM[device.platform].has(params.button)) {
      throw new UnsupportedOperationError(
        "button",
        device,
        `button '${params.button}' is not available on ${device.platform}`
      );
    }
    if (isPhysicalIos(device)) {
      const name = COREDEVICE_BUTTON[params.button];
      if (!name) {
        throw new UnsupportedOperationError(
          "button",
          device,
          `button '${params.button}' is not available on physical iOS (CoreDevice exposes home, power, volumeUp, volumeDown)`
        );
      }
      const coreDevice = services.coreDevice as CoreDeviceApi;
      await coreDevice.button(name);
      return { pressed: params.button };
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

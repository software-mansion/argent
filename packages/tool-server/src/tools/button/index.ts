import { z } from "zod";
import type { Platform, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../../utils/android-input";
import { ensureDep } from "../../utils/check-deps";

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
 * Per-platform buttons; the flat zod enum is the union of both platforms'.
 * Rejecting here is required because `sendCommand` is fire-and-forget and
 * cannot report a backend rejection — an unsupported button would be a silent
 * no-op the tool still reports as a successful `{ pressed }`.
 */
export const BUTTONS_BY_PLATFORM: Record<Platform, ReadonlySet<Params["button"]>> = {
  "ios": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  "ios-remote": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  "android": new Set(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]),
  // The capability gate excludes chromium; the empty set keeps the lookup total.
  "chromium": new Set([]),
  // Vega buttons / D-pad go through the `tv-remote` tool; the capability omits
  // `vega`, so this entry only keeps the record total.
  "vega": new Set([]),
};

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const buttonTool: ToolDefinition<Params, Result> = {
  id: "button",
  interaction: {
    startedMsg: ({ params }) => `Pressing ${params.button} button`,
    completedMsg: ({ params }) => `Pressed ${params.button} button`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to press ${params.button} button: ${failureSignal.error_code}`,
  },
  description: `Press a device hardware button (iOS simulator, Android emulator or device). iOS sends a Down then Up event automatically; Android injects a single \`adb\` key event.
Supported buttons depend on the platform: home, back, power, volumeUp, volumeDown, appSwitch, actionButton — buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android) are rejected with a clear error.
Use when you need to trigger hardware button events.
Returns { pressed: buttonName }.
Fails if the device backend is not reachable — the simulator-server for iOS, or \`adb\` for Android (Android presses are injected with \`adb shell input keyevent\`).`,
  zodSchema,
  capability,
  // The Android path uses `adb`, so declaring the service for an Android target
  // would spawn a sim-server the tool never uses (up to a 30s ready-wait) and
  // could throw ServiceInitializationError before the adb path even runs.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "android" ? {} : { simulatorServer: simulatorServerRef(device) };
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
    if (device.platform === "android") {
      // `adb`, not the simulator-server's HID transport, which the guest silently
      // drops on AVDs created with `hw.keyboard = no` / `hw.mainKeys = no`; adb
      // lands regardless and surfaces a failure as a throw. The
      // BUTTONS_BY_PLATFORM guard above guarantees a keycode for every accepted
      // button.
      //
      // The tool declares no global `requires`, so preflight adb here for the
      // clean 424 install hint on a missing binary.
      await ensureDep("adb");
      await injectAndroidKeycode(params.udid, ANDROID_BUTTON_KEYCODES[params.button]!);
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

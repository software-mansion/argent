import { z } from "zod";
import type { Platform, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { pressButton, type RunnerButton } from "../../utils/ios-device/runner-commands";
import { RunnerCommandError } from "../../utils/ios-device/runner-client";
import { isIosPhysicalDevice, resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  holdUitestQueue,
  remainingBudget,
} from "../../utils/harmony-uitest";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { ANDROID_BUTTON_KEYCODES, injectAndroidKeycode } from "../../utils/android-input";
import { ensureDep } from "../../utils/check-deps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or HarmonyOS id)."),
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
 * Rejecting here keeps the error specific: `sendCommand` now surfaces the
 * server's rejection, but as a generic parse error naming the wire format
 * rather than the platform that lacks the button.
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
  // `uitest uiInput keyEvent` names exactly these three (`Back`/`Home`/`Power`)
  // and otherwise takes a raw numeric keyID. The named three are listed because
  // each was confirmed on a device: Power toggles `powerStatus` ON↔SUSPEND, Home
  // and Back both move the foreground bundle out of an app and back to the
  // launcher. The rest are omitted rather than mapped from documented keycodes —
  // `uitest` accepts any number and reports `No Error` whatever it does, so an
  // unverified mapping would be indistinguishable from a working one.
  "harmony": new Set(["home", "back", "power"]),
};

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  harmony: { device: true },
};

/** The names `uitest uiInput keyEvent` accepts, for the buttons it can press. */
const HARMONY_BUTTON_KEYS: Partial<Record<Params["button"], string>> = {
  home: "Home",
  back: "Back",
  power: "Power",
};

// Hardware buttons the XCUITest runner can press. power and appSwitch have no XCTest API.
const PHYSICAL_IOS_BUTTONS: ReadonlySet<string> = new Set<RunnerButton>([
  "home",
  "volumeUp",
  "volumeDown",
  "actionButton",
]);

/** Wire code the runner answers for a button this particular hardware lacks. */
const RUNNER_UNSUPPORTED_OPERATION_CODE = "UNSUPPORTED_OPERATION";

/** Narrows an accepted button to the runner's `button` wire names. */
function isPhysicalIosButton(button: Params["button"]): button is RunnerButton {
  return PHYSICAL_IOS_BUTTONS.has(button);
}

export const buttonTool: ToolDefinition<Params, Result> = {
  id: "button",
  interaction: {
    startedMsg: ({ params }) => `Pressing ${params.button} button`,
    completedMsg: ({ params }) => `Pressed ${params.button} button`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to press ${params.button} button: ${failureSignal.error_code}`,
  },
  description: `Press a device hardware button (iOS simulator or physical device, Android emulator or device, HarmonyOS device). iOS simulators send a Down then Up event automatically; Android injects a single \`adb\` key event; HarmonyOS injects one \`uitest uiInput keyEvent\`.
Supported buttons depend on the platform: home, back, power, volumeUp, volumeDown, appSwitch, actionButton — buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android, 'power' or 'appSwitch' on a physical iPhone, anything beyond home/back/power on HarmonyOS) are rejected with a clear error.
Use when you need to trigger hardware button events.
Returns { pressed: buttonName }.
Fails if the device backend is not reachable — the simulator-server for iOS, \`adb\` for Android (presses are injected with \`adb shell input keyevent\`), or \`hdc\` for HarmonyOS.`,
  zodSchema,
  capability,
  // Declare only the service the resolved path actually consumes. The Android
  // path uses `adb`, so a sim-server here would spawn a service the tool never
  // uses (up to a 30s ready-wait) and could throw ServiceInitializationError
  // before the adb path even runs.
  // Declare the runner only for a button this path can press. A rejected button must not pay a runner cold start.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "android" || device.platform === "harmony") return {};
    if (isIosPhysicalDevice(device)) {
      return isPhysicalIosButton(params.button)
        ? { iosDeviceRunner: iosDeviceRunnerRef(device) }
        : {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const available = BUTTONS_BY_PLATFORM[device.platform];
    if (!available.has(params.button)) {
      // Name the set, as the sibling `keyboard` does for an unsupported key:
      // HarmonyOS accepts three of the seven buttons, so a refusal that only
      // says which one failed leaves an agent guessing at the other six. The
      // platforms whose set is empty are refused by the capability gate above,
      // so this list never is.
      throw new UnsupportedOperationError(
        "button",
        device,
        `button '${params.button}' is not available on ${device.platform}. ` +
          `Supported: ${[...available].join(", ")}`
      );
    }
    if (isIosPhysicalDevice(device)) {
      if (!isPhysicalIosButton(params.button)) {
        throw new UnsupportedOperationError(
          "button",
          device,
          `button '${params.button}' is not available on a physical iOS device: XCUITest ` +
            "exposes no API for the power/lock button or the app switcher"
        );
      }
      try {
        await pressButton(services.iosDeviceRunner as IosDeviceRunnerApi, params.button);
      } catch (error) {
        // Only the device knows its hardware: actionButton on a non-Pro iPhone
        // comes back as UNSUPPORTED_OPERATION. That is the same capability
        // verdict as the platform checks above, not a runner fault.
        if (
          error instanceof RunnerCommandError &&
          error.code === RUNNER_UNSUPPORTED_OPERATION_CODE
        ) {
          throw new UnsupportedOperationError("button", device, error.message);
        }
        throw error;
      }
      return { pressed: params.button };
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
    if (device.platform === "harmony") {
      // Same reasoning as the Android branch above: presses go over the
      // platform's own injection path rather than the simulator-server HID
      // transport, so preflight the connector here (services() skips the
      // sim-server for HarmonyOS). The BUTTONS_BY_PLATFORM guard above
      // guarantees a key name exists for every accepted button.
      await ensureDep("hdc");
      const connectKey = harmonyConnectKey(device.id);
      // One deadline for both display reads and the press, so the pair stays
      // under the MCP layer's abort-and-replay cap.
      const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
      // Fast prefilter, ahead of the queue wait: a panel already suspended is
      // refused without waiting behind this device's queued work. It is NOT the
      // check the injection trusts — see inside the hold.
      if (params.button !== "power") {
        assertHarmonyDisplayReady(await harmonyDisplay(connectKey), `press ${params.button}`);
      }
      await holdUitestQueue(connectKey, deadline, async (ui) => {
        // `uitest uiInput keyEvent` answers `No Error` against a suspended panel
        // while the press lands nowhere, so `home` and `back` share the guard
        // every other input tool uses — re-read while holding the queue, since
        // the prefilter saw a state that may be stale by the time the press
        // reaches the device.
        //
        // `power` is exempt, and exempt before any display read — it is what
        // the refusal tells the caller to wake the device with, and the one key
        // that works while the panel is suspended.
        if (params.button !== "power") {
          assertHarmonyDisplayReady(
            await harmonyDisplay(
              connectKey,
              remainingBudget(connectKey, deadline, "the display re-read")
            ),
            `press ${params.button}`
          );
        }
        await ui.keyEvent(HARMONY_BUTTON_KEYS[params.button]!);
      });
      return { pressed: params.button };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    await sendCommand(api, {
      cmd: "button",
      direction: "Down",
      button: params.button,
    });
    await sleep(50);
    await sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
    return { pressed: params.button };
  },
};

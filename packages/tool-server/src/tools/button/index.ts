import { z } from "zod";
import type { Platform, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  harmonyKeyEvent,
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
 * Hardware buttons that physically exist per platform. The zod enum is the
 * union of both platforms' buttons (a flat enum can't express the dependency),
 * so we refine here: iOS has no `back`, Android has no `actionButton`.
 *
 * Rejecting at the tool layer is required because the simulator-server
 * transport is fire-and-forget (see `sendCommand`) and cannot report a backend
 * rejection — an unsupported button would otherwise be a silent no-op that the
 * tool still reports as a successful `{ pressed }`.
 */
export const BUTTONS_BY_PLATFORM: Record<Platform, ReadonlySet<Params["button"]>> = {
  "ios": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  // Remote iOS sims expose the same hardware buttons as local iOS.
  "ios-remote": new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  "android": new Set(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]),
  // Chromium apps have no hardware buttons; the capability gate already
  // excludes them, the empty set keeps the lookup total if one slips through.
  "chromium": new Set([]),
  // Vega is remote-driven: hardware buttons / D-pad go through the dedicated
  // `tv-remote` tool, and this tool's capability omits `vega` so a Vega device is
  // rejected before this map is consulted. Empty set keeps the record total.
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

export const buttonTool: ToolDefinition<Params, Result> = {
  id: "button",
  interaction: {
    startedMsg: ({ params }) => `Pressing ${params.button} button`,
    completedMsg: ({ params }) => `Pressed ${params.button} button`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to press ${params.button} button: ${failureSignal.error_code}`,
  },
  description: `Press a device hardware button (iOS simulator, Android emulator or device, HarmonyOS device). iOS sends a Down then Up event automatically; Android injects a single \`adb\` key event; HarmonyOS injects one \`uitest uiInput keyEvent\`.
Supported buttons depend on the platform: home, back, power, volumeUp, volumeDown, appSwitch, actionButton — buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android, anything beyond home/back/power on HarmonyOS) are rejected with a clear error.
Use when you need to trigger hardware button events.
Returns { pressed: buttonName }.
Fails if the device backend is not reachable — the simulator-server for iOS, \`adb\` for Android (presses are injected with \`adb shell input keyevent\`), or \`hdc\` for HarmonyOS.`,
  zodSchema,
  capability,
  // Android presses go over `adb shell input keyevent` (see execute), not the
  // simulator-server's HID transport, so declaring the service for an Android
  // target would needlessly resolve + spawn a sim-server the tool never uses (up
  // to a 30s ready-wait) and could throw ServiceInitializationError before the
  // adb path even runs. Declare it only for the iOS / ios-remote path that
  // actually consumes it (mirrors the sibling `keyboard` tool's lazy services).
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "android" || device.platform === "harmony"
      ? {}
      : { simulatorServer: simulatorServerRef(device) };
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
    if (device.platform === "android") {
      // Android presses go over `adb shell input keyevent`, not the
      // simulator-server's HID transport, which the guest silently drops on AVDs
      // created with `hw.keyboard = no` / `hw.mainKeys = no`. adb lands
      // regardless and surfaces a failure as a throw. The BUTTONS_BY_PLATFORM
      // guard above guarantees a keycode exists for every accepted button.
      //
      // Preflight adb here (the tool declares no global `requires` because the
      // iOS path doesn't need it, and `services` skips the sim-server for
      // Android) so a missing binary fails with the clean 424 install hint,
      // mirroring the sibling `keyboard` tool's per-platform `requires: ["adb"]`.
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
      // One deadline for the display read and the press, so the pair stays under
      // the MCP layer's abort-and-replay cap.
      const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
      // `uitest uiInput keyEvent` answers `No Error` against a suspended panel
      // while the press lands nowhere, so `home` and `back` share the guard the
      // tap, swipe and typing backends use: a screen timeout mid-session must
      // not turn the keys an agent recovers with into silent no-ops.
      //
      // `power` is exempt, and exempt before the display read — it is what the
      // refusal tells the caller to wake the device with, and the one key that
      // works while the panel is suspended.
      if (params.button !== "power") {
        assertHarmonyDisplayReady(await harmonyDisplay(connectKey), `press ${params.button}`);
      }
      await harmonyKeyEvent(connectKey, HARMONY_BUTTON_KEYS[params.button]!, deadline - Date.now());
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

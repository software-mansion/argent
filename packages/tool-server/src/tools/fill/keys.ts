import { FailureError, getFailureSignal, type DeviceInfo, type Registry } from "@argent/registry";
import { FAILURE_CODES } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { adbShell } from "../../utils/adb";
import { injectAndroidText } from "../../utils/android-input";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { RunnerCommandError } from "../../utils/ios-device/runner-client";
import { typeText } from "../../utils/ios-device/runner-commands";
import { charToKeyPress, NAMED_KEYS } from "../keyboard/key-codes";
import { typeSimulatorServer } from "../keyboard/simulator-server-keys";
import { noFocusedFieldError, untypeableTextError } from "./errors";

/**
 * The `keys` method: empty the focused field with a delete-key burst, then type
 * the text. Used where the native fill is missing — an ax-service or Android
 * helper older than `fill`, or a physical iPhone — and as the second try when a
 * native fill did not read back.
 *
 * The burst is bounded: 100 backspaces interleaved with 100 forward deletes
 * clear 100 characters on each side of the caret. A tap leaves the caret at
 * the end, so a longer value keeps its start.
 */
const CLEAR_KEY_PAIRS = 100;

// USB HID usages. `NAMED_KEYS.backspace` is 42; forward delete (76) has no
// named key.
const FORWARD_DELETE_HID = 76;
// android.view.KeyEvent: KEYCODE_DEL, KEYCODE_FORWARD_DEL.
const ANDROID_DEL = 67;
const ANDROID_FORWARD_DEL = 112;
// XCUIKeyboardKey.delete: XCTest's typeText presses Delete for it.
const XCTEST_DELETE = "\u0008";

const CLEAR_KEY_CADENCE_MS = 2;
// The keys are fire-and-forget; let the app drain the burst before typing.
const CLEAR_SETTLE_MS = 300;
const TYPE_DELAY_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every character has a HID key on the simulator keyboard. */
export function typeableOnSimulator(text: string): boolean {
  for (const char of text) if (!charToKeyPress(char)) return false;
  return true;
}

/** `adb shell input text` types printable ASCII only. */
export function typeableOnAndroid(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) return false;
  }
  return true;
}

/**
 * Re-throws a transport failure with the original telemetry signal and a
 * message of our own: the backends' messages can quote their input (the
 * Android `input text` command line), and that input is the caller's text.
 */
async function withoutTextInErrors<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const signal = getFailureSignal(err);
    throw new FailureError(
      "fill's key fallback failed partway: the focused field may be partly cleared or " +
        "partly typed. Read it before retrying.",
      signal ?? {
        error_code: FAILURE_CODES.FILL_NOT_VERIFIED,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "unknown",
      }
    );
  }
}

export async function pressSimulatorBackspace(
  registry: Registry,
  device: DeviceInfo
): Promise<void> {
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  await api.pressKey("Down", NAMED_KEYS.backspace!);
  await api.pressKey("Up", NAMED_KEYS.backspace!);
  await sleep(CLEAR_SETTLE_MS);
}

/** iOS simulator (local or remote): HID keys over simulator-server. */
export async function fillBySimulatorKeys(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<void> {
  if (!typeableOnSimulator(text)) throw untypeableTextError("fill_keys_untypeable_ios");
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  await withoutTextInErrors("fill_keys_ios", async () => {
    for (let i = 0; i < CLEAR_KEY_PAIRS; i++) {
      for (const key of [NAMED_KEYS.backspace!, FORWARD_DELETE_HID]) {
        await api.pressKey("Down", key);
        await api.pressKey("Up", key);
        await sleep(CLEAR_KEY_CADENCE_MS);
      }
    }
    await sleep(CLEAR_SETTLE_MS);
    if (text) {
      await typeSimulatorServer(registry, device, {
        udid: device.id,
        text,
        delayMs: TYPE_DELAY_MS,
      });
    }
  });
}

/** Android phone or tablet: one `input keyevent` burst, then `input text`. */
export async function fillByAndroidKeys(serial: string, text: string): Promise<void> {
  if (!typeableOnAndroid(text)) throw untypeableTextError("fill_keys_untypeable_android");
  const burst = Array.from(
    { length: CLEAR_KEY_PAIRS },
    () => `${ANDROID_DEL} ${ANDROID_FORWARD_DEL}`
  ).join(" ");
  await withoutTextInErrors("fill_keys_android", async () => {
    await adbShell(serial, `input keyevent ${burst}`, { timeoutMs: 30_000 });
    if (text) await injectAndroidText(serial, text);
  });
}

/**
 * Physical iPhone: XCTest's typeText through the runner, which types any
 * character and presses Delete for `\b`. It has no forward delete, so only the
 * text before the caret is cleared.
 */
export async function fillByDeviceKeys(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<void> {
  const bundleId = requireCurrentIosDeviceApp(device.id);
  const ref = iosDeviceRunnerRef(device);
  const api = await registry.resolveService<IosDeviceRunnerApi>(ref.urn, ref.options);
  const type = async (chars: string) => {
    try {
      await typeText(api, bundleId, chars);
    } catch (err) {
      if (err instanceof RunnerCommandError && err.code === "TEXT_INPUT_NOT_FOCUSED") {
        throw noFocusedFieldError("fill_keys_ios_device_focus");
      }
      throw err;
    }
  };
  await type(XCTEST_DELETE.repeat(CLEAR_KEY_PAIRS));
  if (text) await withoutTextInErrors("fill_keys_ios_device", () => type(text));
}

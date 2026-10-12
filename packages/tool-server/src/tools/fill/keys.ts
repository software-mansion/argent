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
 * the text. Used only where no native fill exists: an ax-service or Android
 * helper older than `fill`, a helper that cannot start, or a physical iPhone.
 * On an iOS secure field the ax-service clears and this only types.
 *
 * The burst clears `pairs` characters wherever the caret is. On iOS it moves
 * the caret right `pairs` times, then sends `pairs` backspaces; on Android
 * one `input keyevent` sends backspaces interleaved with forward deletes.
 * Callers size it from the field's length when they can read it, up to 100.
 */
const MAX_CLEAR_KEY_PAIRS = 100;

// USB HID usage of Right Arrow; `NAMED_KEYS.backspace` is 42.
const ARROW_RIGHT_HID = 79;
// android.view.KeyEvent: KEYCODE_DEL, KEYCODE_FORWARD_DEL.
const ANDROID_DEL = 67;
const ANDROID_FORWARD_DEL = 112;
// XCUIKeyboardKey.delete: XCTest's typeText presses Delete for it.
const XCTEST_DELETE = "\u0008";

/**
 * Key timing. Measured in Safari on iOS 26.5 with the 0.28.0 ax-service: keys
 * held for 2 ms and sent 2 ms apart lose about one delete in four; held 20 ms
 * and sent 20 ms apart, every delete lands. Native fields keep up with
 * either. The keys are fire-and-forget, so the app gets `settleMs` to drain
 * the burst before typing. Mutable for tests only.
 */
export const KEY_TIMING = { holdMs: 20, cadenceMs: 20, settleMs: 300, typeDelayMs: 30 };

/** Delete-key pairs for a field holding `length` characters. */
export function clearPairsFor(length: number | undefined): number {
  if (length === undefined) return MAX_CLEAR_KEY_PAIRS;
  return Math.min(MAX_CLEAR_KEY_PAIRS, length + 1);
}

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
  await sleep(KEY_TIMING.holdMs);
  await api.pressKey("Up", NAMED_KEYS.backspace!);
  await sleep(KEY_TIMING.settleMs);
}

/** iOS simulator (local or remote): types `text` with HID keys over simulator-server. */
export async function typeOnSimulator(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<void> {
  if (!typeableOnSimulator(text)) throw untypeableTextError("fill_keys_untypeable_ios");
  if (!text) return;
  await withoutTextInErrors("fill_keys_ios", () =>
    typeSimulatorServer(registry, device, {
      udid: device.id,
      text,
      delayMs: KEY_TIMING.typeDelayMs,
    })
  );
}

/** iOS simulator (local or remote): a delete burst, then the text, as HID keys. */
export async function fillBySimulatorKeys(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  pairs: number = MAX_CLEAR_KEY_PAIRS
): Promise<void> {
  if (!typeableOnSimulator(text)) throw untypeableTextError("fill_keys_untypeable_ios");
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  await withoutTextInErrors("fill_keys_ios", async () => {
    // The caret goes to the end with Right Arrow, then Backspace deletes
    // everything before it. Forward delete is no use here: WebKit ignores it,
    // stalls on it and drops the keys that follow.
    for (const key of [ARROW_RIGHT_HID, NAMED_KEYS.backspace!]) {
      for (let i = 0; i < pairs; i++) {
        await api.pressKey("Down", key);
        await sleep(KEY_TIMING.holdMs);
        await api.pressKey("Up", key);
        await sleep(KEY_TIMING.cadenceMs);
      }
    }
    await sleep(KEY_TIMING.settleMs);
  });
  await typeOnSimulator(registry, device, text);
}

/** Android phone or tablet: one `input keyevent` burst, then `input text`. */
export async function fillByAndroidKeys(
  serial: string,
  text: string,
  pairs: number = MAX_CLEAR_KEY_PAIRS
): Promise<void> {
  if (!typeableOnAndroid(text)) throw untypeableTextError("fill_keys_untypeable_android");
  const burst = Array.from({ length: pairs }, () => `${ANDROID_DEL} ${ANDROID_FORWARD_DEL}`).join(
    " "
  );
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
  await type(XCTEST_DELETE.repeat(MAX_CLEAR_KEY_PAIRS));
  if (text) await withoutTextInErrors("fill_keys_ios_device", () => type(text));
}

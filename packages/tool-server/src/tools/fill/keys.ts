import { FailureError, getFailureSignal, type DeviceInfo, type Registry } from "@argent/registry";
import { FAILURE_CODES } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { RunnerCommandError } from "../../utils/ios-device/runner-client";
import { typeText } from "../../utils/ios-device/runner-commands";
import { charToKeyPress, NAMED_KEYS } from "../keyboard/key-codes";
import { typeSimulatorServer } from "../keyboard/simulator-server-keys";
import { noFocusedFieldError } from "./errors";

/**
 * The keys `fill` still presses where no AX edit can do the job: typing into
 * an iOS secure field the ax-service has cleared, one backspace for a Safari
 * password input, and the whole fill on a physical iPhone.
 */
const MAX_CLEAR_KEYS = 100;

// XCUIKeyboardKey.delete: XCTest's typeText presses Delete for it.
const XCTEST_DELETE = "\u0008";

/**
 * Key timing. Keys are fire-and-forget, so the app gets `settleMs` to take a
 * backspace before it is read back. Mutable for tests only.
 */
export const KEY_TIMING = { holdMs: 20, settleMs: 300, typeDelayMs: 30 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every character has a HID key on the simulator keyboard. */
export function typeableOnSimulator(text: string): boolean {
  for (const char of text) if (!charToKeyPress(char)) return false;
  return true;
}

/**
 * Re-throws a transport failure with the original telemetry signal and a
 * message of our own: a backend's message can quote its input, and that input
 * is the caller's text.
 */
async function withoutTextInErrors<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const signal = getFailureSignal(err);
    throw new FailureError(
      "fill failed partway through typing: the focused field may hold part of the text. " +
        "Read it before retrying.",
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
  if (!text) return;
  await withoutTextInErrors("fill_keys_ios", () =>
    typeSimulatorServer(registry, device, {
      udid: device.id,
      text,
      delayMs: KEY_TIMING.typeDelayMs,
    })
  );
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
  await type(XCTEST_DELETE.repeat(MAX_CLEAR_KEYS));
  if (text) await withoutTextInErrors("fill_keys_ios_device", () => type(text));
}

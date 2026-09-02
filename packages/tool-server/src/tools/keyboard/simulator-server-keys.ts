import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  charToKeyPress,
  CLEAR_KEY_PAIRS,
  FORWARD_DELETE_KEYCODE,
  NAMED_KEYS,
  SHIFT_KEYCODE,
} from "./key-codes";
import { InvalidToolInputError } from "../../utils/capability";
import type { KeyboardParams, KeyboardResult } from "./types";

import { sleepOrAbort } from "../../utils/timing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Android phones/tablets do not use this HID transport — they inject over
// `adb shell input` instead (utils/android-input.ts, #449).
export async function typeSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  const pressKeyCode = async (keyCode: number, withShift = false) => {
    if (withShift) {
      api.pressKey("Down", SHIFT_KEYCODE);
      await sleep(10);
    }
    api.pressKey("Down", keyCode);
    await sleep(delay);
    api.pressKey("Up", keyCode);
    if (withShift) {
      await sleep(10);
      api.pressKey("Up", SHIFT_KEYCODE);
    }
    keysPressed++;
  };

  // The tool rejects more than one of text / key / clear (./index.ts), and a
  // clear routes to `clearSimulatorServer` below, so at most one block here runs.
  if (params.text) {
    for (const char of params.text) {
      const press = charToKeyPress(char);
      // Caller input error → 400 via the error class, so the granular
      // KEYBOARD_CHARACTER_UNSUPPORTED code survives (#420).
      if (!press)
        throw new InvalidToolInputError(`No keycode for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_simulator",
          error_kind: "unsupported",
        });
      await pressKeyCode(press.keyCode, press.withShift);
      await sleep(delay);
    }
  }

  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: a prototype key like "constructor" would otherwise
    // pass the nullish guard with a garbage value (Object.prototype.constructor).
    const namedKeyCode = Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : undefined;
    if (namedKeyCode == null) {
      // Schema-valid but unusable (`key` is a free string) — 400 via the error
      // class, so the KEYBOARD_KEY_UNSUPPORTED code survives (#420), matching
      // the Android path.
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_simulator",
          error_kind: "unsupported",
        }
      );
    }
    await pressKeyCode(namedKeyCode);
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

// The burst's own cadence, deliberately not `delayMs`: that parameter paces
// typing so an app's per-keystroke work (a search-as-you-type request, a
// validation pass) keeps up, and its 50ms default would stretch 200 delete keys
// to 10s. The simulator-server delivers a 200-key burst written with no delay at
// all, in order and without drops; 2ms keeps that margin on a loaded host and
// still finishes the burst in under a second.
// Exported so the two constants are pinned SEPARATELY: the timed test below
// bounds only their sum, where a cadence of 5 and a settle of 1000 both stay
// green and a settle-named case goes red for a cadence change.
export const CLEAR_KEY_CADENCE_MS = 2;

// `pressKey` is fire-and-forget, so the burst returns before the app has drained
// it. Without a settle the tool's auto-screenshot races the deletions and hands
// back a picture of the field mid-clear.
export const CLEAR_SETTLE_MS = 300;

/**
 * An abandoned burst is a FAILURE, not a short success.
 *
 * The iOS simulator and the Apple TV daemon are the two backends that can stop
 * MID-burst, so a 200 here filed the dangerous half-emptied field as a COMPLETED
 * step — `run-sequence` counts a returned step in `completed`, and a flow step
 * with no verdict of its own passes on it — while the two adb backends throw for
 * the harmless "nothing was sent" case (utils/android-input.ts,
 * utils/vega-input.ts, `cancelledBeforeSend`). The split was inverted relative to
 * the risk, and a partial clear was uncountable in telemetry on the only two
 * backends that can produce one.
 *
 * Same two-sentence shape as those two, so all four now read alike.
 */
export function abandonedClearError(
  deviceId: string,
  keysSent: number,
  stage: string
): FailureError {
  return new FailureError(
    keysSent === 0
      ? `the clear burst was cancelled before it was sent to ${deviceId}, so NO delete key was ` +
          "sent and the focused field is unchanged. The request had already been aborted — the " +
          "caller disconnected, or the run was cancelled — when the burst was due. Nothing needs " +
          "to be read back."
      : `the clear burst was cancelled partway on ${deviceId}, and the focused field may be ` +
          `PARTIALLY emptied — ${keysSent} of the ${CLEAR_KEY_PAIRS * 2} delete keys had been ` +
          "written one at a time when the request was aborted. Read the field back (`describe`) " +
          "before clearing or typing again.",
    {
      error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
      failure_stage: stage,
      failure_area: "tool_server",
      // Client-side cancellation matches no other FailureKind; the adb siblings
      // land on whatever `describeAdbFailure` gave their ABORT_ERR.
      error_kind: "unknown",
    }
  );
}

/**
 * Empty the focused text field over HID: `CLEAR_KEY_PAIRS` backspaces
 * interleaved with as many forward-deletes.
 *
 * No Cmd+A first. The chord does work on iOS, but holding Left-GUI across
 * awaits latches it if anything in between throws, and a concurrent
 * `{ text: "w" }` from another call then becomes Cmd+W. The pair of delete keys
 * needs no modifier at all, so nothing can latch and the two backends stay
 * identical (utils/android-input.ts `injectAndroidClear`).
 *
 * Bidirectional for the same reason as there: the caret sits wherever the focus
 * tap left it, both keys join lines at a boundary, and pressing either on an
 * empty side is a no-op.
 *
 * `signal` is the request's own abort — the HTTP layer fires it when the client
 * disconnects, and run-sequence and a flow run pass theirs down. Honoured on
 * every cadence gap, for the reason `gesture-swipe` gives for the same shape:
 * without it a cancelled call keeps driving the device for the rest of the
 * burst, its deletions landing in whatever is sent to that device next.
 */
export async function clearSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  let keysSent = 0;
  try {
    for (let i = 0; i < CLEAR_KEY_PAIRS; i++) {
      if (signal?.aborted === true) break;
      api.pressKey("Down", NAMED_KEYS.backspace);
      api.pressKey("Up", NAMED_KEYS.backspace);
      keysSent++;
      if (!(await sleepOrAbort(CLEAR_KEY_CADENCE_MS, signal))) break;
      api.pressKey("Down", FORWARD_DELETE_KEYCODE);
      api.pressKey("Up", FORWARD_DELETE_KEYCODE);
      keysSent++;
      if (!(await sleepOrAbort(CLEAR_KEY_CADENCE_MS, signal))) break;
    }
  } catch (err) {
    // Re-stated for the same reason the Android burst is (utils/android-input.ts
    // `injectAndroidClear`): the burst is not atomic, so a transport that dies
    // partway leaves the field emptied by however many keys got through, and an
    // agent told only "the helper process is gone" reads that as "nothing
    // happened" and types over a field that is now shorter. Measured on a booted
    // sim: `kill -9` of the simulator-server 50ms in delivered 9 of 200 keys.
    throw new FailureError(
      // `keysSent` is what the caller has to act on, and the two ends of it are
      // opposite instructions. With the transport's `pipeDead` guard the FIRST
      // `pressKey` can throw with nothing delivered — a `stop-simulator-server`
      // or a simulator shutdown between resolving the api and writing to it —
      // and asserting partial emptying there sends the caller to re-read a field
      // nothing touched. The Android and Vega bursts already split the same way
      // (utils/android-input.ts, utils/vega-input.ts).
      (keysSent === 0
        ? `the clear burst never reached ${device.id}: the transport refused the very first of ` +
          `the ${CLEAR_KEY_PAIRS * 2} delete keys, so NO delete key was sent and the focused ` +
          "field is unchanged. Nothing needs to be read back — retry the clear once " +
          "simulator-server is back. "
        : `the clear burst did not finish on ${device.id}, and the focused field may be ` +
          `PARTIALLY emptied — ${keysSent} of the ${CLEAR_KEY_PAIRS * 2} delete keys had been ` +
          "written one at a time when the transport stopped accepting them. Read the field back " +
          "(`describe`) before clearing or typing again. ") +
        "Underlying failure: " +
        (err instanceof Error ? err.message.split("\n")[0] : String(err)),
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
        failure_stage: "keyboard_clear_simulator_burst",
        failure_area: "tool_server",
        error_kind: getFailureSignal(err)?.error_kind ?? "subprocess",
      },
      { cause: err instanceof Error ? err : undefined }
    );
  }
  // A burst the caller abandoned FAILS rather than returning a short success:
  // a half-emptied field reported as a completed step is the shape `cleared`
  // must not be claimed for, and `run-sequence` counts a returned step in
  // `completed`. No settle either — there is no auto-screenshot to protect once
  // the request is gone.
  if (keysSent < CLEAR_KEY_PAIRS * 2) {
    throw abandonedClearError(device.id, keysSent, "keyboard_clear_simulator_abandoned");
  }
  await sleep(CLEAR_SETTLE_MS);
  // `keys` counts what was SENT — the field is never read back, so the result
  // says nothing about what it now holds. It IS now evidence that every key
  // reached the transport: a burst cut short throws or returns short above.
  return { typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true };
}

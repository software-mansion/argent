import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { isRemoteTvOsSimulator } from "../../../utils/sim-remote";
import { setSimulatorClipboardText } from "../../../utils/simulator-client";
import { charToKeyPress } from "../../keyboard/key-codes";
import type { PasteParams, PasteResult, PasteServices } from "../types";

/** USB HID usage id of the left GUI (⌘) key. */
const LEFT_GUI_KEYCODE = 0xe3;
const V_KEYCODE = charToKeyPress("v")!.keyCode;

const CHORD_STEP_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An Apple TV simulator is a plain UUID that `resolveDevice` classifies as a
 * simulator, indistinguishable from an iPhone by shape, so the capability
 * matrix cannot exclude it.
 */
function rejectTv(device: DeviceInfo): never {
  throw new UnsupportedOperationError(
    "paste",
    device,
    "tvOS has no pasteboard to paste from — type into the focused field with keyboard instead"
  );
}

/**
 * ⌘V on the simulator's hardware keyboard is the path UIKit maps to the focused
 * field's paste action. `setSimulatorClipboardText` resolves only once the
 * device pasteboard holds the text, so the chord cannot race the fill.
 */
async function pasteSimulator(api: SimulatorServerApi, text: string): Promise<PasteResult> {
  await setSimulatorClipboardText(api, text);
  // `pressKey` throws once the key transport is gone, and its message is written
  // for the KEYBOARD burst — "this key press and any that follow it in the same
  // burst … before typing or clearing again", words with no referent for a
  // four-key chord. Re-stated for a paste, and wrapped so a failure between the
  // ⌘ down and the ⌘ up cannot leave the modifier LATCHED on the simulator:
  // that is the exact hazard the clear burst avoids by holding no modifier at
  // all (../../keyboard/simulator-server-keys.ts).
  api.pressKey("Down", LEFT_GUI_KEYCODE);
  try {
    await sleep(CHORD_STEP_MS);
    api.pressKey("Down", V_KEYCODE);
    await sleep(CHORD_STEP_MS);
    api.pressKey("Up", V_KEYCODE);
    await sleep(CHORD_STEP_MS);
    api.pressKey("Up", LEFT_GUI_KEYCODE);
  } catch (err) {
    try {
      api.pressKey("Up", LEFT_GUI_KEYCODE);
    } catch {
      /* the transport is gone; nothing can un-latch it from here */
    }
    throw new FailureError(
      "the paste chord did not finish on the simulator: the key transport stopped accepting " +
        "events partway through Cmd+V, so the text is on the device clipboard but may not have " +
        "been pasted. Nothing was typed. Read the field back (`describe`) before pasting again. " +
        "Underlying failure: " +
        (err instanceof Error ? err.message.split("\n")[0] : String(err)),
      {
        error_code: FAILURE_CODES.SIMULATOR_SERVER_TERMINATED,
        failure_stage: "paste_ios_chord",
        failure_area: "tool_server",
        error_kind: getFailureSignal(err)?.error_kind ?? "subprocess",
      },
      { cause: err instanceof Error ? err : undefined }
    );
  }
  // `pressKey` only writes a line to the server's stdin, so the final Up needs
  // the same gap before success is reported — otherwise the caller's next action,
  // or the MCP auto-screenshot, precedes the completed chord.
  await sleep(CHORD_STEP_MS);
  return { pasted: true };
}

export function makeIosImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteParams, PasteResult> {
  return {
    // `xcrun` is for the `isTvOsSimulator` probe; simulator-server comes from
    // the blueprint.
    requires: ["xcrun"],
    async handler(_services, params, device) {
      if (await isTvOsSimulator(device.id)) rejectTv(device);
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      return pasteSimulator(api, params.text);
    },
  };
}

/**
 * Remote sims paste through the MoQ transport's `paste`: `sim-remote simctl
 * pbcopy` fills the remote pasteboard, then ⌘V rides the MoQ control channel.
 * The HTTP clipboard route does not exist for a remote sim.
 */
export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteParams, PasteResult> {
  return {
    requires: ["sim-remote"],
    async handler(_services, params, device) {
      if (await isRemoteTvOsSimulator(device.id)) rejectTv(device);
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      if (!api.transport) {
        throw new Error(
          `Tool 'paste' resolved an ios-remote simulator-server without a transport for ${device.id}.`
        );
      }
      await api.transport.paste(params.text);
      return { pasted: true };
    },
  };
}

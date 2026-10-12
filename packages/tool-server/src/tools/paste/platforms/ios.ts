import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError, UnsupportedOperationError } from "../../../utils/capability";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { isRemoteTvOsSimulator } from "../../../utils/sim-remote";
import { setSimulatorClipboardText } from "../../../utils/simulator-client";
import { charToKeyPress } from "../../keyboard/key-codes";
import { typeSimulatorServer } from "../../keyboard/simulator-server-keys";
import type { PasteDispatchParams, PasteParams, PasteResult, PasteServices } from "../types";

/** USB HID usage id of the left GUI (⌘) key. */
const LEFT_GUI_KEYCODE = 0xe3;
const V_KEYCODE = charToKeyPress("v")!.keyCode;

const CHORD_STEP_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether typing `char` enters it as text. A newline or a tab has a key, but
 * typing it presses Return or Tab, which submits a form or moves the focus,
 * where a paste would only have inserted it.
 */
const typesAsText = (char: string) => !"\n\r\t".includes(char) && !!charToKeyPress(char);

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
 *
 * A secret goes to the clipboard as `sensitive`. On a simulator that Device Hub
 * (Xcode 27) has opened since it booted, simulator-server refuses it, as Device
 * Hub can copy that clipboard to the Mac clipboard, and the secret is typed
 * instead, the way `keyboard` types it.
 */
async function pasteSimulator(
  registry: Registry,
  device: DeviceInfo,
  api: SimulatorServerApi,
  params: PasteDispatchParams
): Promise<PasteResult> {
  const sensitive = params.hasSecrets === true;
  if ((await setSimulatorClipboardText(api, params.text, { sensitive })) === "refused") {
    // Checked up front, so nothing is half-typed, and without naming the
    // character, which is part of the secret.
    if (![...params.text].every(typesAsText)) {
      throw new InvalidToolInputError(
        "Paste failed: Device Hub has opened this simulator, so a secret is typed instead of " +
          "pasted, and this secret holds a newline, a tab or a character the keyboard cannot " +
          "type. Nothing was typed.",
        {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "paste_secret_typed_simulator",
          error_kind: "unsupported",
        }
      );
    }
    await typeSimulatorServer(registry, device, { udid: params.udid, text: params.text });
    return { pasted: true, via: "keyboard" };
  }
  await api.pressKey("Down", LEFT_GUI_KEYCODE);
  await sleep(CHORD_STEP_MS);
  await api.pressKey("Down", V_KEYCODE);
  await sleep(CHORD_STEP_MS);
  await api.pressKey("Up", V_KEYCODE);
  await sleep(CHORD_STEP_MS);
  await api.pressKey("Up", LEFT_GUI_KEYCODE);
  // On the spawned server `pressKey` only writes a line to its stdin, so the
  // final Up needs the same gap before success is reported — otherwise the
  // caller's next action, or the MCP auto-screenshot, precedes the completed
  // chord.
  await sleep(CHORD_STEP_MS);
  return { pasted: true };
}

export function makeIosImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteDispatchParams, PasteResult> {
  return {
    // `xcrun` is for the `isTvOsSimulator` probe; simulator-server comes from
    // the blueprint.
    requires: ["xcrun"],
    async handler(_services, params, device) {
      if (await isTvOsSimulator(device.id)) rejectTv(device);
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      return pasteSimulator(registry, device, api, params);
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

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

/** Gap between the HID events of the ⌘V chord, matching the keyboard tool's cadence. */
const CHORD_STEP_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An Apple TV simulator is a plain UUID that `resolveDevice` classifies as
 * `ios` / `simulator`, indistinguishable from an iPhone by shape, so the
 * capability matrix cannot exclude it. tvOS has no text pasteboard a field
 * could paste from, and simulator-server does not drive a tvOS sim at all.
 */
function rejectTv(device: DeviceInfo): never {
  throw new UnsupportedOperationError(
    "paste",
    device,
    "tvOS has no pasteboard to paste from — type into the focused field with keyboard instead"
  );
}

/**
 * Fill the simulator pasteboard, then press ⌘V on the simulator's hardware
 * keyboard. UIKit maps the chord to the focused field's paste action — the same
 * path a user with a connected keyboard takes. The pasteboard fill is
 * synchronous on the server, so the chord can't land before the text does.
 */
async function pasteSimulator(api: SimulatorServerApi, text: string): Promise<PasteResult> {
  await setSimulatorClipboardText(api, text);
  api.pressKey("Down", LEFT_GUI_KEYCODE);
  await sleep(CHORD_STEP_MS);
  api.pressKey("Down", V_KEYCODE);
  await sleep(CHORD_STEP_MS);
  api.pressKey("Up", V_KEYCODE);
  await sleep(CHORD_STEP_MS);
  api.pressKey("Up", LEFT_GUI_KEYCODE);
  // `pressKey` is fire-and-forget (a line on the server's stdin). Give the
  // final Up the same gap as the other events before reporting success, so the
  // caller's next action — or the MCP auto-screenshot — never precedes the
  // completed chord.
  await sleep(CHORD_STEP_MS);
  return { pasted: true };
}

export function makeIosImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteParams, PasteResult> {
  return {
    // `isTvOsSimulator` shells out to `simctl`; the simulator-server itself is
    // resolved through the blueprint.
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
 * Remote simulators route through the MoQ transport's `paste` primitive, which
 * fills the remote pasteboard (`sim-remote simctl pbcopy`) and presses ⌘V over
 * the same control channel — the HTTP clipboard route does not exist there.
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

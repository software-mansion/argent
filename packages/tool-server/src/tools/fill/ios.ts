import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";
import {
  noFocusedFieldError,
  notAnsweredError,
  notChangedError,
  notVerifiedError,
  unsupportedFieldError,
} from "./errors";
import { pressSimulatorBackspace, typeableOnSimulator, typeOnSimulator } from "./keys";
import type { FillResult } from "./types";

const NEWLINE = /[\r\n]/;

/**
 * iOS simulator, local or remote. The ax-service selects all through the AX
 * text operations and inserts (or deletes), with no app injection; the app
 * sees an ordinary edit. It reads the field back itself, by its selection
 * length, and answers only whether it matched.
 *
 * - A native secure field drops inserted text: the daemon clears it, and the
 *   text is typed with keys and read back.
 * - A web password input ignores the delete but keeps its text selected, and
 *   one HID backspace clears it.
 * - A write that does not read back fails with FILL_NOT_VERIFIED. Keys never
 *   follow a native write: they would type into whatever the write left.
 */
export async function fillIos(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);

  // Keys on a secure field type into a single-line input, where a newline is
  // Return: it would submit the form.
  const typeable = typeableOnSimulator(text) && !NEWLINE.test(text);
  const first = await ax.fill(text, { typeable });
  if (!first.focused) throw noFocusedFieldError("fill_ios_no_focus");
  if (first.unsupported) {
    throw unsupportedFieldError(
      "the focused element is not a text input (a date or time input, or a picker)",
      "fill_ios_unsupported_field"
    );
  }
  if (first.singleLine) {
    throw unsupportedFieldError(
      "a single-line text field cannot hold a newline",
      "fill_ios_single_line"
    );
  }
  if (first.timedOut) throw notAnsweredError("fill_ios_timeout");
  if (first.untouched) throw notChangedError("fill_ios_select_failed");
  if (first.verified) return { verified: true };

  if (first.secure) {
    if (!typeable) {
      throw unsupportedFieldError(
        "a secure text field takes only text the keyboard can type on one line, and this text has a character it cannot",
        "fill_ios_secure_untypeable"
      );
    }
    if (!first.cleared) throw notVerifiedError("fill_ios_secure_not_cleared");
    await typeOnSimulator(registry, device, text);
    const check = await ax.fill(text, { check: true });
    if (check.verified) return { verified: true };
    throw notVerifiedError("fill_ios_not_verified");
  }

  if (first.needsBackspace) {
    await pressSimulatorBackspace(registry, device);
    const check = await ax.fill(text, { check: true });
    if (check.verified) return { verified: true };
  }
  throw notVerifiedError("fill_ios_not_verified");
}

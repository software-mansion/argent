import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";
import { noFocusedFieldError, notVerifiedError, unsupportedFieldError } from "./errors";
import { fillBySimulatorKeys, pressSimulatorBackspace, typeableOnSimulator } from "./keys";
import type { FillResult } from "./types";

/**
 * iOS simulator, local or remote. The ax-service selects all through the AX
 * text operations and inserts (or deletes), with no app injection; the app
 * sees an ordinary edit. It reads the field back itself and answers only
 * whether it matched.
 *
 * - An ax-service older than `fill` falls back to keys, unverified.
 * - A web password input ignores the delete but keeps its text selected, and
 *   one HID backspace clears it.
 * - A native secure field drops inserted text, so the daemon leaves it
 *   untouched and it is typed into with keys.
 * - A write that does not read back is retried with keys and read back again.
 */
export async function fillIos(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);

  const first = await ax.fill(text);
  if (first === null) {
    await fillBySimulatorKeys(registry, device, text);
    return { method: "keys", verified: null };
  }
  if (!first.focused) throw noFocusedFieldError("fill_ios_no_focus");
  if (first.verified) return { method: "accessibility", verified: true, length: first.length };

  // A native secure field was left untouched: it takes only typed text.
  if (first.secure && !typeableOnSimulator(text)) {
    throw unsupportedFieldError(
      "a secure text field takes only text the keyboard can type, and this text has a character it cannot",
      "fill_ios_secure_untypeable"
    );
  }

  if (first.needsBackspace) {
    await pressSimulatorBackspace(registry, device);
    const check = await ax.fill(text, { check: true });
    if (check?.verified) return { method: "accessibility", verified: true, length: check.length };
  }

  if (!typeableOnSimulator(text)) throw notVerifiedError("accessibility", "fill_ios_not_verified");
  await fillBySimulatorKeys(registry, device, text);
  const check = await ax.fill(text, { check: true });
  if (check?.verified) return { method: "keys", verified: true, length: check.length };
  throw notVerifiedError("keys", "fill_ios_not_verified");
}

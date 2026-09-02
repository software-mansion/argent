import type { Registry, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported, UnsupportedOperationError } from "./capability";
import { describeDevice, deviceEntryId, isBooted, listDevices } from "./booted-devices";
import type { SubInvokeContext } from "./sub-invoke";

/**
 * Stands in for the device id while the rest of a call's arguments are judged.
 * Never reaches a tool; a suite check pins that every device arg accepts it.
 */
export const AUTO_DEVICE_TARGET_PROBE = "00000000-0000-4000-8000-000000000000";

/**
 * Thrown when a caller omitted `udid` and the server cannot name one device for
 * it. The message carries the listing the caller would otherwise have had to run
 * `list-devices` for: every device when none matched, since a shut-down one is
 * what they most likely meant, and the candidates alone when several did.
 */
export class AutoDeviceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoDeviceTargetError";
  }
}

/**
 * The single booted device this tool can drive, for a call that named none.
 *
 * Deliberately narrow: it resolves only when exactly ONE booted device passes
 * the tool's own `capability` gate. Two candidates is an ambiguity the server
 * has no basis to break — picking either would send a gesture to a device the
 * caller was not looking at — so it refuses and names them.
 *
 * The capability filter is what makes a mixed pool work: with an iPhone and a
 * Chromium app both up, `chromium-tabs` still resolves, because the iPhone is
 * not a candidate for it.
 *
 * It narrows by platform and kind only. A UDID does not say whether it belongs
 * to an iPhone or an Apple TV, and `capability` has no key to ask with, so a
 * lone booted Apple TV simulator IS a candidate for `gesture-tap`, and a lone
 * booted iPhone IS one for `tv-remote`. What that costs is the tool's own
 * business and differs per tool: `tv-remote`, `paste`, `shake` and
 * `screen-recording-start` refuse the mismatch by name, `keyboard` types on the
 * TV (only its named keys are refused), and the seven gesture tools carry no
 * call-time guard at all. The `runtimeKind` that `list-devices` reports per
 * entry is the signal that would settle it, and this resolver does not read it.
 */
export async function resolveAutoDeviceTarget(
  registry: Registry,
  def: ToolDefinition,
  ctx?: SubInvokeContext
): Promise<string> {
  const devices = await listDevices(registry, ctx);
  const booted = devices.filter(isBooted);

  const candidates = booted.filter((entry) => {
    const id = deviceEntryId(entry);
    if (!id) return false;
    if (!def.capability) return true;
    try {
      assertSupported(def.id, def.capability, resolveDevice(id));
      return true;
    } catch (err) {
      // Only a declined device drops out of the pool. `capability.supports` is
      // the tool's own code and can fail on its own account; swallowing that
      // would answer an internal fault with "no booted device runs <tool>".
      if (err instanceof UnsupportedOperationError) return false;
      throw err;
    }
  });

  if (candidates.length === 1) {
    // Non-null: deviceEntryId already returned a string for every candidate.
    return deviceEntryId(candidates[0]!)!;
  }

  const listing = devices.length ? devices.map(describeDevice).join(", ") : "none";
  if (candidates.length === 0) {
    // Without this an entry the listing prints as `Booted` sits directly under
    // "no booted device", and the caller has no way to tell why it was passed
    // over.
    const remoteNote = devices.some((d) => d.platform === "ios-remote" && d.state === "Booted")
      ? " A remote simulator is never resolved automatically — name one by id to use it."
      : "";
    throw new AutoDeviceTargetError(
      `No booted device runs \`${def.id}\`, so \`udid\` could not be resolved. ` +
        `Boot one, or pass \`udid\` explicitly. Devices: ${listing}.${remoteNote}`
    );
  }
  throw new AutoDeviceTargetError(
    `\`udid\` is ambiguous: ${candidates.length} booted devices match the platforms ` +
      `\`${def.id}\` declares — pass one explicitly. ` +
      `Candidates: ${candidates.map(describeDevice).join(", ")}.`
  );
}

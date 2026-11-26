import { FAILURE_CODES, isValidSession } from "@argent/registry";
import { InvalidToolInputError } from "./capability";
import { canonicalDeviceId } from "./debugger/device-alias";
import { externalNativeId } from "./external-devices";

const CLAIM_IDLE_MINUTES = 10;
const CLAIM_IDLE_TIMEOUT_MS = CLAIM_IDLE_MINUTES * 60_000;

export const RELEASE_DEVICE_TOOL_ID = "release-device";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaimOwner = "this session" | "another session";

interface Claim {
  session: string;
  lastUsedAt: number;
  activeCalls: number;
  /** Released while a call was in flight: the claim ends when the last call does. */
  released?: boolean;
}

export type ClaimResult = { ok: true; done: () => void } | { ok: false; device: string };

/**
 * Which session drives each device. A claim lasts while its session keeps
 * calling: it ends on release, or once the device has had no call in flight
 * for {@link CLAIM_IDLE_TIMEOUT_MS}.
 */
export class DeviceClaims {
  private readonly claims = new Map<string, Claim>();

  constructor(
    private readonly idleTimeoutMs = CLAIM_IDLE_TIMEOUT_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Claims every device for `session` for the length of one call, or names the
   * first one another session holds. Call `done` when the call ends.
   */
  claim(session: string, devices: readonly string[]): ClaimResult {
    const busy = devices.find((device) => {
      const claim = this.liveClaim(device);
      return claim !== undefined && claim.session !== session;
    });
    if (busy !== undefined) return { ok: false, device: busy };

    const held = devices.map((device) => this.hold(device, session));
    return {
      ok: true,
      done: () => {
        for (const [index, claim] of held.entries()) {
          claim.activeCalls -= 1;
          claim.lastUsedAt = this.now();
          if (claim.released && claim.activeCalls === 0) this.drop(devices[index]!, claim);
        }
      },
    };
  }

  /**
   * Releases `session`'s claim on `device`, or on every device it holds. A
   * device with a call in flight stays claimed until that call ends. Returns
   * the released devices.
   */
  release(session: string, device?: string): string[] {
    const released: string[] = [];
    for (const key of [...this.claims.keys()]) {
      const claim = this.liveClaim(key);
      if (!claim || claim.released || claim.session !== session) continue;
      if (device !== undefined && key !== device) continue;
      if (claim.activeCalls > 0) claim.released = true;
      else this.claims.delete(key);
      released.push(key);
    }
    return released;
  }

  ownerOf(device: string, session: string | undefined): ClaimOwner | undefined {
    const claim = this.liveClaim(device);
    if (!claim) return undefined;
    return claim.session === session ? "this session" : "another session";
  }

  private liveClaim(device: string): Claim | undefined {
    const claim = this.claims.get(device);
    if (!claim) return undefined;
    if (claim.activeCalls === 0 && this.now() - claim.lastUsedAt > this.idleTimeoutMs) {
      this.claims.delete(device);
      return undefined;
    }
    return claim;
  }

  private drop(device: string, claim: Claim): void {
    if (this.claims.get(device) === claim) this.claims.delete(device);
  }

  private hold(device: string, session: string): Claim {
    const existing = this.liveClaim(device);
    const claim = existing ?? { session, lastUsedAt: this.now(), activeCalls: 0 };
    claim.activeCalls += 1;
    claim.lastUsedAt = this.now();
    claim.released = false;
    this.claims.set(device, claim);
    return claim;
  }
}

export const deviceClaims = new DeviceClaims();

/** One key per device, whichever of its names the caller used. */
export function claimKey(deviceId: string): string {
  const nativeId = externalNativeId(deviceId);
  const id = canonicalDeviceId(nativeId) ?? nativeId;
  return UUID_SHAPE.test(id) ? id.toUpperCase() : id;
}

/** The devices a call acts on: `udid`, `device_id`, `devices` or e2e-execute's `device`. */
export function claimTargets(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const ids = [record.udid, record.device_id, record.device];
  if (Array.isArray(record.devices)) ids.push(...record.devices);
  const named = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(named.map(claimKey))];
}

/** The session a header names, `undefined` when absent, or `null` for an unusable one. */
export function parseSession(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  const session = header.trim();
  return isValidSession(session) ? session : null;
}

export function deviceInUseMessage(device: string): string {
  return (
    `Device ${device} is in use by another Argent session. Pick another device from list-devices, ` +
    `or wait: the claim ends when that session releases it, disconnects, or makes no call to it for ${CLAIM_IDLE_MINUTES} minutes.`
  );
}

/** Claims a device a tool picked itself, after the HTTP gate saw no device in its arguments. */
export function claimPickedDevice(session: string | undefined, deviceId: string): () => void {
  if (!session) return () => {};
  const claim = deviceClaims.claim(session, [claimKey(deviceId)]);
  if (!claim.ok) {
    throw new InvalidToolInputError(deviceInUseMessage(claim.device), {
      error_code: FAILURE_CODES.DEVICE_IN_USE,
      failure_stage: "picked_device_claim",
    });
  }
  return claim.done;
}

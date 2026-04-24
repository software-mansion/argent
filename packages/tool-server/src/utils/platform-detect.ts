import { listIosSimulators } from "./ios-devices";
import { listAndroidSerials } from "./adb";

export type Platform = "ios" | "android";

const cache = new Map<string, { platform: Platform; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Last-resort shape match used only when both `xcrun simctl list` and
 * `adb devices` are unreachable (no Xcode AND no adb installed). Kept narrow
 * on purpose — only the classic iOS simulator UUID (8-4-4-4-12) counts as iOS.
 * The 8-16 short form is physical-device-only and cannot be driven by simctl,
 * so including it here would just mis-route a caller into a "device not
 * booted" error instead of a clean "unknown device" path.
 */
function matchesIosSimulatorShape(udid: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(udid);
}

/**
 * Classify a device id by looking it up in the actual simctl + adb inventories.
 *
 * Truth-from-inventory: if the id appears in `xcrun simctl list`, it is iOS;
 * if it appears in `adb devices`, it is Android. When neither listing is
 * reachable (no platform tooling installed) we fall back to the shape
 * heuristic so the downstream tool can still attempt the action and surface
 * its own "device not booted" error rather than ours.
 *
 * Results cached per-udid for CACHE_TTL_MS so a burst of tool calls pays at
 * most one pair of listing shell-outs. Cache is also warmed by `list-devices`.
 */
export async function classifyDevice(udid: string): Promise<Platform> {
  const cached = cache.get(udid);
  if (cached && cached.expiresAt > Date.now()) return cached.platform;

  const [iosHit, androidHit] = await Promise.all([udidInIosList(udid), udidInAndroidList(udid)]);

  let platform: Platform;
  if (iosHit && !androidHit) {
    platform = "ios";
  } else if (androidHit && !iosHit) {
    platform = "android";
  } else {
    // Either not-found-anywhere (unknown / not booted) or found-in-both
    // (collision — never observed in practice but possible). Fall back to
    // shape. The classic iOS simulator UUID is the only pattern that should
    // still route to iOS; everything else is treated as adb serial because
    // that's how every real-world Android serial arrives.
    platform = matchesIosSimulatorShape(udid) ? "ios" : "android";
  }

  cache.set(udid, { platform, expiresAt: Date.now() + CACHE_TTL_MS });
  return platform;
}

/**
 * Pre-populate the classify cache with known-good entries — typically called
 * right after `list-devices` runs so subsequent tool calls are cache hits.
 */
export function warmDeviceCache(entries: Iterable<{ udid: string; platform: Platform }>): void {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  for (const e of entries) {
    cache.set(e.udid, { platform: e.platform, expiresAt });
  }
}

/** Test-only: clear the cache between tests so TTL leakage doesn't masquerade as a real hit. */
export function __resetClassifyCacheForTests(): void {
  cache.clear();
}

async function udidInIosList(udid: string): Promise<boolean> {
  const sims = await listIosSimulators();
  return sims.some((s) => s.udid === udid);
}

async function udidInAndroidList(udid: string): Promise<boolean> {
  const devices = await listAndroidSerials().catch(() => []);
  return devices.some((d) => d.serial === udid);
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isPhysicalIosUdid } from "./device-info";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
}

export interface IosPhysicalDevice {
  udid: string;
  name: string;
  /** Apple product type, e.g. "iPhone15,4". Null when devicectl omits it. */
  productType: string | null;
  /** Always "connected" — only currently-reachable devices are returned. */
  state: string;
}

interface DevicectlDevice {
  hardwareProperties?: { udid?: string; platform?: string; productType?: string };
  deviceProperties?: { name?: string };
  connectionProperties?: { transportType?: string; tunnelState?: string };
}

interface DevicectlOutput {
  result?: { devices?: DevicectlDevice[] };
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

/**
 * List all available iOS and tvOS simulators via `xcrun simctl list devices --json`.
 * Returns an empty array when xcrun is missing or the call fails so the
 * rest of the tool surface stays usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: 10_000,
      killSignal: SIMCTL_KILL_SIGNAL,
    });
    const data: SimctlOutput = JSON.parse(stdout);
    const out: IosSimulator[] = [];
    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      // Accept both iOS and tvOS runtimes
      if (!runtimeId.includes("iOS") && !runtimeId.includes("tvOS")) continue;
      for (const d of devices) {
        if (!d.isAvailable) continue;
        const runtimeKind = runtimeId.includes("tvOS") ? "tv" : "mobile";
        out.push({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: runtimeId,
          runtimeKind,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * List connected physical iOS devices via `xcrun devicectl list devices`.
 *
 * devicectl only emits stable machine output to a file (`--json-output`), never
 * stdout, so we write to a temp file and parse it. We keep only devices that are
 * actually reachable right now: iOS platform with a `connectionProperties.transportType`
 * (wired/network). Paired-but-offline devices carry a `tunnelState: "unavailable"`
 * and no `transportType`, and are dropped — listing them would invite taps that
 * can't land. Returns an empty array on any failure so the rest of `list-devices`
 * stays usable on non-mac hosts or without Xcode.
 */
export function parsePhysicalIosDevices(data: DevicectlOutput): IosPhysicalDevice[] {
  const out: IosPhysicalDevice[] = [];
  for (const d of data.result?.devices ?? []) {
    const udid = d.hardwareProperties?.udid;
    const platform = d.hardwareProperties?.platform;
    const transport = d.connectionProperties?.transportType;
    // Keep only iOS (skip watchOS/tvOS), with a physical ECID UDID, that is
    // currently reachable. The `isPhysicalIosUdid` (8hex-16hex) check is
    // load-bearing: `devicectl list devices` also enumerates the host's iOS
    // *simulators*, which report `platform: "iOS"` with
    // `transportType: "sameMachine"` (verified against real devicectl JSON) —
    // without the shape gate every simulator surfaces as a phantom physical
    // device. It also keeps discovery consistent with `classifyDevice`, which
    // routes only this UDID shape to the CoreDevice backend. A reachable device
    // reports a `transportType` (wired/network); paired-but-offline ones carry
    // `tunnelState: "unavailable"` and no transport, and are dropped.
    if (!udid || platform !== "iOS" || !isPhysicalIosUdid(udid) || !transport) continue;
    if (d.connectionProperties?.tunnelState === "unavailable") continue;
    out.push({
      udid,
      name: d.deviceProperties?.name ?? "iPhone",
      productType: d.hardwareProperties?.productType ?? null,
      state: "connected",
    });
  }
  return out;
}

export async function listIosDevices(): Promise<IosPhysicalDevice[]> {
  if (process.platform !== "darwin") return [];
  const outPath = join(tmpdir(), `argent-devicectl-${randomUUID()}.json`);
  try {
    await execFileAsync(
      "xcrun",
      ["devicectl", "list", "devices", "--quiet", "--json-output", outPath],
      { timeout: 15_000 }
    );
    const data: DevicectlOutput = JSON.parse(await readFile(outPath, "utf8"));
    return parsePhysicalIosDevices(data);
  } catch {
    return [];
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}

// A simulator's runtime kind is fixed at creation (an iOS sim can't become a
// tvOS one), so memoize per-UDID to keep the hot describe/screenshot path from
// paying the ~100ms `simctl list` cost on every call. Only successful lookups
// are cached; an unknown UDID re-probes (the sim may simply not be booted yet).
const runtimeKindCache = new Map<string, "mobile" | "tv">();

/**
 * Resolve the runtime kind ("mobile" | "tv") of an iOS-shaped simulator UDID,
 * or undefined when it isn't a known available simulator (or xcrun is missing).
 *
 * `resolveDevice` classifies by UDID shape alone and can't tell tvOS from iOS —
 * both are 8-4-4-4-12 UUIDs tagged `platform: "ios"`. Code paths that must
 * branch on tvOS (describe, screenshot) call this to get the real runtime.
 */
export async function getSimulatorRuntimeKind(udid: string): Promise<"mobile" | "tv" | undefined> {
  const cached = runtimeKindCache.get(udid);
  if (cached) return cached;
  const kind = (await listIosSimulators()).find((s) => s.udid === udid)?.runtimeKind;
  if (kind) runtimeKindCache.set(udid, kind);
  return kind;
}

/** True when the given iOS-shaped UDID is actually a tvOS (Apple TV) simulator. */
export async function isTvOsSimulator(udid: string): Promise<boolean> {
  return (await getSimulatorRuntimeKind(udid)) === "tv";
}

/**
 * Memoize a runtime-kind verdict a caller already resolved out-of-band — e.g. the
 * tv-control factory, which fetches the simulator list to validate the target and
 * so holds the kind in hand. Warming the cache here lets the synchronous telemetry
 * reader refine that device without a redundant `simctl` probe, and mirrors how
 * the Android TV factory's `getAndroidRuntimeKind` warms its cache. No-op for an
 * undefined kind; a simulator's kind is fixed at creation, so it never goes stale.
 */
export function cacheSimulatorRuntimeKind(udid: string, kind: "mobile" | "tv" | undefined): void {
  if (kind) runtimeKindCache.set(udid, kind);
}

/**
 * Synchronous, cache-only view of a UDID's runtime kind: returns the memoized
 * "mobile"/"tv" verdict if a prior `getSimulatorRuntimeKind` call resolved it,
 * otherwise undefined. It NEVER runs `simctl` — callers on a latency-sensitive
 * hot path (telemetry platform inference) use this to distinguish tvOS from iOS
 * only when the kind is already known, and fall back to the coarse platform when
 * it isn't, rather than paying a ~100ms probe per call. The cache is warmed as a
 * side effect of the describe/screenshot/keyboard/streaming and tv-remote
 * (tv-control) paths that any real tvOS session exercises.
 */
export function getCachedSimulatorRuntimeKind(udid: string): "mobile" | "tv" | undefined {
  return runtimeKindCache.get(udid);
}

/** Test-only: clear the iOS runtime-kind memo so cases don't leak verdicts. */
export function __resetSimulatorRuntimeKindCacheForTesting(): void {
  runtimeKindCache.clear();
}

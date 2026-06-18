import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
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
 * List all available iOS simulators via `xcrun simctl list devices --json`.
 * Returns an empty array when xcrun is missing or the call fails so the
 * rest of the tool surface stays usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: 10_000,
    });
    const data: SimctlOutput = JSON.parse(stdout);
    const out: IosSimulator[] = [];
    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      if (!runtimeId.includes("iOS")) continue;
      for (const d of devices) {
        if (!d.isAvailable) continue;
        out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeId });
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
    // iOS only (skip watchOS/tvOS), and only currently-connected devices: a
    // reachable device reports a `transportType` (wired/network); paired-but-
    // offline ones carry `tunnelState: "unavailable"` and no transport.
    if (!udid || platform !== "iOS" || !transport) continue;
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

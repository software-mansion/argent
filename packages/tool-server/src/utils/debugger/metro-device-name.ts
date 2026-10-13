import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyDevice } from "../device-info";
import { externalNativeId } from "../external-devices";
import { deviceSetForUdid, simctlPrefix } from "../ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../simctl-config";

const execFileAsync = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * How Metro's inspector-proxy lists an iOS simulator, so a UDID can be matched
 * to its debugger target once several devices share one Metro.
 *
 * Metro never sees the UDID; its `/json/list` only carries a per-connection
 * `logicalDeviceId` and the `deviceName` the app reported, which on a simulator
 * is `UIDevice.name`, the simulator's simctl name.
 *
 * Android serials get no hint: the name an Android app reports
 * (`<model> - <release> - API <sdk>`) is shared by every emulator built from
 * the same system image and cannot be renamed, so it identifies nothing.
 */
export interface MetroDeviceNames {
  /** The simulator's simctl name. */
  name: string;
  /** Every form Metro may list `name` under. */
  forms: string[];
  /** How many other booted simulators carry the same name. */
  bootedTwins: number;
}

/**
 * RN sends the name in the inspector URL's query without escaping `+` or `&`,
 * and the proxy parses it with `url.parse(…, true)`: `+` becomes a space and
 * `&` ends the value.
 */
function asParsedByMetro(name: string): string {
  return name.split("&")[0]!.replace(/\+/g, " ");
}

/** The simulator's names, or undefined when `deviceId` is not a local simulator or the lookup fails. */
export async function metroDeviceNamesFor(deviceId: string): Promise<MetroDeviceNames | undefined> {
  if (classifyDevice(deviceId) !== "ios") return undefined;
  try {
    return await iosSimulatorNames(deviceId);
  } catch {
    return undefined;
  }
}

async function iosSimulatorNames(deviceId: string): Promise<MetroDeviceNames | undefined> {
  const udid = externalNativeId(deviceId).toUpperCase();
  const args = [...simctlPrefix(await deviceSetForUdid(deviceId)), "list", "devices", "-j"];
  const { stdout } = await execFileAsync("xcrun", args, {
    timeout: LOOKUP_TIMEOUT_MS,
    killSignal: SIMCTL_KILL_SIGNAL,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ udid: string; name: string; state?: string }>>;
  };
  const all = Object.values(parsed.devices ?? {}).flat();
  const hit = all.find((d) => d.udid.toUpperCase() === udid);
  if (!hit) return undefined;
  const bootedTwins = all.filter(
    (d) => d.state === "Booted" && d.name === hit.name && d.udid.toUpperCase() !== udid
  ).length;
  return {
    name: hit.name,
    forms: [...new Set([hit.name, asParsedByMetro(hit.name)])],
    bootedTwins,
  };
}

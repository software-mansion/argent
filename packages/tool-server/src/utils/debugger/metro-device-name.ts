import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyDevice } from "../device-info";
import { externalNativeId } from "../external-devices";
import {
  configuredAdditionalDeviceSets,
  deviceSetForUdid,
  simctlPrefix,
  type DeviceSetPath,
} from "../ios-device-sets";
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

type SimctlDevice = { udid: string; name: string; state?: string };

async function listDevices(deviceSet: DeviceSetPath): Promise<SimctlDevice[]> {
  const { stdout } = await execFileAsync(
    "xcrun",
    [...simctlPrefix(deviceSet), "list", "devices", "-j"],
    { timeout: LOOKUP_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as { devices?: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices ?? {}).flat();
}

/**
 * The booted simulators of every other device set. One Metro serves simulators
 * from all of them, so a same-named simulator in another set is a twin too.
 * A set that is missing or fails to list counts as empty: it is only used to
 * refuse, never to resolve.
 */
async function otherSetDevices(own: DeviceSetPath): Promise<SimctlDevice[]> {
  const sets = [null, ...configuredAdditionalDeviceSets()].filter(
    (set) => set !== own && (set === null || fs.existsSync(set))
  );
  const lists = await Promise.all(sets.map((set) => listDevices(set).catch(() => [])));
  return lists.flat();
}

async function iosSimulatorNames(deviceId: string): Promise<MetroDeviceNames | undefined> {
  const udid = externalNativeId(deviceId).toUpperCase();
  const ownSet = await deviceSetForUdid(deviceId);
  const [own, others] = await Promise.all([listDevices(ownSet), otherSetDevices(ownSet)]);
  const hit = own.find((d) => d.udid.toUpperCase() === udid);
  if (!hit) return undefined;
  // Compare as Metro lists them: `QA&1` and `QA&2` both reach it as `QA`.
  const parsedName = asParsedByMetro(hit.name);
  const bootedTwins = [...own, ...others].filter(
    (d) =>
      d.state === "Booted" &&
      d.udid.toUpperCase() !== udid &&
      (d.name === hit.name || asParsedByMetro(d.name) === parsedName)
  ).length;
  return {
    name: hit.name,
    forms: [...new Set([hit.name, parsedName])],
    bootedTwins,
  };
}

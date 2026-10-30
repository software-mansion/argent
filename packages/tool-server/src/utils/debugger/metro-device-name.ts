import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyDevice } from "../device-info";
import { externalNativeId, listExternalDevices } from "../external-devices";
import {
  configuredAdditionalDeviceSets,
  deviceSetForUdid,
  simctlPrefix,
  type DeviceSetPath,
} from "../ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../simctl-config";
import { simctlListDevices } from "../sim-remote";

const execFileAsync = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 3000;
const LOOKUP_DEADLINE_MS = 5000;

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
  /** Whether the simulator itself is booted. */
  booted: boolean;
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

const metroPortsWithHostedSimulators = new Set<number>();

/** Record that a hosted `remote:` simulator's app is tunneled into the Metro on `port`. */
export function noteHostedSimulatorOnMetro(port: number): void {
  metroPortsWithHostedSimulators.add(port);
}

/**
 * The simulator's names, or undefined when `deviceId` is not a local simulator
 * or any lookup fails or outlasts `LOOKUP_DEADLINE_MS`, including a listing
 * that could hide a same-named twin.
 */
export async function metroDeviceNamesFor(
  deviceId: string,
  port: number
): Promise<MetroDeviceNames | undefined> {
  if (classifyDevice(deviceId) !== "ios") return undefined;
  try {
    return await withDeadline(iosSimulatorNames(deviceId, port), LOOKUP_DEADLINE_MS);
  } catch {
    return undefined;
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`lookup exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
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

async function providerDeviceSets(): Promise<DeviceSetPath[]> {
  const devices = await listExternalDevices({ probe: false });
  return devices.filter((d) => d.platform === "ios").map((d) => d.deviceSet ?? null);
}

/**
 * The simulators of every other device set: the default one, the configured
 * ones and those providers declare. One Metro serves simulators from all of
 * them, so a same-named simulator in another set is a twin too. A set that
 * fails to list rejects, since it may hold a twin.
 */
async function otherSetDevices(own: DeviceSetPath): Promise<SimctlDevice[]> {
  const candidates = [null, ...configuredAdditionalDeviceSets(), ...(await providerDeviceSets())];
  const sets = [...new Set(candidates)].filter(
    (set) => set !== own && (set === null || fs.existsSync(set))
  );
  const lists = await Promise.all(sets.map(listDevices));
  return lists.flat();
}

/** The hosted `remote:` simulators, when any of them is tunneled into this Metro. */
async function hostedDevices(port: number): Promise<SimctlDevice[]> {
  if (!metroPortsWithHostedSimulators.has(port)) return [];
  const { devices } = await simctlListDevices({ timeoutMs: LOOKUP_TIMEOUT_MS });
  return Object.values(devices).flat();
}

async function iosSimulatorNames(
  deviceId: string,
  port: number
): Promise<MetroDeviceNames | undefined> {
  const udid = externalNativeId(deviceId).toUpperCase();
  const ownSet = await deviceSetForUdid(deviceId);
  const [own, others, hosted] = await Promise.all([
    listDevices(ownSet),
    otherSetDevices(ownSet),
    hostedDevices(port),
  ]);
  const hit = own.find((d) => d.udid.toUpperCase() === udid);
  if (!hit) return undefined;
  // Compare as Metro lists them: `QA&1` and `QA&2` both reach it as `QA`.
  const parsedName = asParsedByMetro(hit.name);
  const bootedTwins = [...own, ...others, ...hosted].filter(
    (d) =>
      d.state === "Booted" &&
      d.udid.toUpperCase() !== udid &&
      (d.name === hit.name || asParsedByMetro(d.name) === parsedName)
  ).length;
  return {
    name: hit.name,
    forms: [...new Set([hit.name, parsedName])],
    booted: hit.state === "Booted",
    bootedTwins,
  };
}

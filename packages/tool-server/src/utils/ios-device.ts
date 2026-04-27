import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const execFileAsync = promisify(execFile);

interface SimctlDevice {
  udid: string;
  state: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

const simulatorCache = new Map<string, boolean>();

/**
 * Determine whether a UDID belongs to a simulator or a physical device.
 * Checks `xcrun simctl list devices --json` — if the UDID is found, it's a simulator.
 */
export async function checkIsSimulator(udid: string): Promise<boolean> {
  const cached = simulatorCache.get(udid);
  if (cached !== undefined) return cached;

  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"]);
  const data: SimctlOutput = JSON.parse(stdout);

  const allUdids = new Set<string>();
  for (const devices of Object.values(data.devices)) {
    for (const device of devices) {
      allUdids.add(device.udid);
    }
  }

  const result = allUdids.has(udid);
  simulatorCache.set(udid, result);
  return result;
}

interface SimctlAppInfo {
  CFBundleExecutable: string;
  CFBundleIdentifier: string;
  CFBundleDisplayName?: string;
  ApplicationType: string;
}

/**
 * Detect the currently running user app on a simulator.
 * Cross-references `launchctl list` with `simctl listapps` to find the running app.
 * Returns the CFBundleExecutable for use with `xctrace --attach`.
 */
export function detectRunningAppOnSimulator(udid: string): string {
  const launchctlOutput = execSync(`xcrun simctl spawn ${udid} launchctl list`, {
    encoding: "utf-8",
  });

  const runningBundleIds = new Set<string>();
  for (const line of launchctlOutput.split("\n")) {
    const match = line.match(/UIKitApplication:([^\[]+)/);
    if (match) {
      runningBundleIds.add(match[1]);
    }
  }

  if (runningBundleIds.size === 0) {
    throw new Error(
      "No running apps detected on the simulator. Launch the app first using `launch-app`, then retry."
    );
  }

  const listAppsOutput = execSync(`xcrun simctl listapps ${udid} | plutil -convert json -o - -`, {
    encoding: "utf-8",
  });

  const installedApps: Record<string, SimctlAppInfo> = JSON.parse(listAppsOutput);

  const runningUserApps: SimctlAppInfo[] = [];
  for (const [, appInfo] of Object.entries(installedApps)) {
    if (appInfo.ApplicationType === "User" && runningBundleIds.has(appInfo.CFBundleIdentifier)) {
      runningUserApps.push(appInfo);
    }
  }

  if (runningUserApps.length === 0) {
    throw new Error(
      "No running user apps detected on the simulator (only system apps are running). Launch the app first using `launch-app`, then retry."
    );
  }

  if (runningUserApps.length > 1) {
    const appList = runningUserApps
      .map(
        (a) =>
          `  - ${a.CFBundleExecutable} (${a.CFBundleIdentifier}${a.CFBundleDisplayName ? `, "${a.CFBundleDisplayName}"` : ""})`
      )
      .join("\n");
    throw new Error(
      `Multiple user apps are running on the simulator:\n${appList}\nSpecify \`app_process\` with the CFBundleExecutable of the app you want to profile.`
    );
  }

  return runningUserApps[0].CFBundleExecutable;
}

interface DevicectlApp {
  bundleIdentifier: string;
  name: string;
  url: string;
  builtByDeveloper: boolean;
  removable: boolean;
}

interface DevicectlProcess {
  processIdentifier: number;
  executable: string;
}

interface DevicectlAppsResult {
  result: { apps: DevicectlApp[] };
}

interface DevicectlProcessesResult {
  result: { runningProcesses: DevicectlProcess[] };
}

function tmpJsonPath(): string {
  return path.join(os.tmpdir(), `argent-devicectl-${crypto.randomUUID()}.json`);
}

async function readDevicectlJson<T>(tmpFile: string): Promise<T> {
  const raw = await fs.promises.readFile(tmpFile, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Detect the currently running user app on a physical device using `devicectl`.
 * Cross-references installed developer apps with running processes.
 * Returns the CFBundleExecutable (process name) for use with `xctrace --attach`.
 */
export async function detectRunningAppOnDevice(udid: string): Promise<string> {
  const tmpApps = tmpJsonPath();
  const tmpProcs = tmpJsonPath();

  try {
    // 1. Get installed developer apps
    try {
      await execFileAsync(
        "xcrun",
        ["devicectl", "device", "info", "apps", "--device", udid, "--json-output", tmpApps],
        { timeout: 15_000 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        throw new Error(
          "Physical device profiling requires Xcode 15+ (devicectl not found). Update Xcode or use a simulator."
        );
      }
      throw new Error(
        `Could not query apps on device. Ensure it is unlocked, connected via USB, and trusted. (${msg})`
      );
    }

    const appsData = await readDevicectlJson<DevicectlAppsResult>(tmpApps);
    const developerApps = appsData.result.apps.filter((a) => a.builtByDeveloper);

    if (developerApps.length === 0) {
      throw new Error(
        "No developer apps installed on the device. Install and launch your app first, then retry."
      );
    }

    // 2. Get running processes
    try {
      await execFileAsync(
        "xcrun",
        ["devicectl", "device", "info", "processes", "--device", udid, "--json-output", tmpProcs],
        { timeout: 15_000 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not query running processes on device. Ensure it is unlocked and connected. (${msg})`
      );
    }

    const procsData = await readDevicectlJson<DevicectlProcessesResult>(tmpProcs);
    const processes = procsData.result.runningProcesses;

    // 3. Cross-reference: find running developer apps
    const runningApps: {
      name: string;
      bundleIdentifier: string;
      executable: string;
    }[] = [];

    for (const app of developerApps) {
      // App url: "file:///private/var/containers/Bundle/Application/<UUID>/<AppName>.app/"
      // Process executable: "file:///private/var/containers/Bundle/Application/<UUID>/<AppName>.app/<Executable>"
      const appUrl = app.url.endsWith("/") ? app.url : `${app.url}/`;
      const matchingProc = processes.find(
        (p) => p.executable.startsWith(appUrl) && !p.executable.includes(".appex/")
      );
      if (matchingProc) {
        // Extract executable name: last path component of the process URL
        const executableName = matchingProc.executable
          .replace(/^file:\/\//, "")
          .split("/")
          .pop()!;
        runningApps.push({
          name: app.name,
          bundleIdentifier: app.bundleIdentifier,
          executable: executableName,
        });
      }
    }

    if (runningApps.length === 0) {
      throw new Error(
        "No running developer apps detected on the device. Launch your app first, then retry."
      );
    }

    if (runningApps.length > 1) {
      const appList = runningApps
        .map((a) => `  - ${a.executable} (${a.bundleIdentifier}, "${a.name}")`)
        .join("\n");
      throw new Error(
        `Multiple developer apps are running on the device:\n${appList}\nSpecify \`app_process\` with the executable name of the app you want to profile.`
      );
    }

    return runningApps[0].executable;
  } finally {
    await fs.promises.unlink(tmpApps).catch(() => {});
    await fs.promises.unlink(tmpProcs).catch(() => {});
  }
}

interface DevicectlListDevice {
  identifier: string;
  hardwareProperties: {
    udid: string;
    platform: string;
    marketingName?: string;
    productType?: string;
  };
  deviceProperties: {
    name: string;
    osVersionNumber: string;
    bootState?: string;
  };
  connectionProperties: {
    transportType: string;
    pairingState: string;
  };
}

interface DevicectlListResult {
  result: { devices: DevicectlListDevice[] };
}

export interface PhysicalDevice {
  udid: string;
  name: string;
  model: string;
  osVersion: string;
  connectionType: string;
}

export interface ListPhysicalDevicesResult {
  devices: PhysicalDevice[];
  error?: string;
}

/**
 * List physical iOS devices connected to the host via `devicectl`.
 * Returns `{ devices: [] }` on success with no devices, or `{ devices: [], error }`
 * when devicectl itself fails (e.g. Xcode < 15, device locked/untrusted) so the
 * caller can surface the reason instead of silently reporting "no devices".
 */
export async function listPhysicalDevices(): Promise<ListPhysicalDevicesResult> {
  const tmpFile = tmpJsonPath();
  try {
    await execFileAsync("xcrun", ["devicectl", "list", "devices", "--json-output", tmpFile], {
      timeout: 15_000,
    });

    const data = await readDevicectlJson<DevicectlListResult>(tmpFile);

    const devices = data.result.devices
      .filter((d) => d.hardwareProperties.platform === "iOS")
      .map((d) => ({
        udid: d.hardwareProperties.udid,
        name: d.deviceProperties.name,
        model: d.hardwareProperties.marketingName ?? d.hardwareProperties.productType ?? "Unknown",
        osVersion: d.deviceProperties.osVersionNumber,
        connectionType: d.connectionProperties.transportType,
      }));

    return { devices };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      msg.includes("ENOENT") || msg.includes("not found")
        ? "devicectl not found — physical device listing requires Xcode 15+."
        : `devicectl failed: ${msg}. Ensure the device is unlocked, connected, and trusted.`;
    return { devices: [], error: hint };
  } finally {
    await fs.promises.unlink(tmpFile).catch(() => {});
  }
}

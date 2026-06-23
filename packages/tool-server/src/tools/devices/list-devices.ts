import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds, consolePortFromAdbSerial } from "../../utils/adb";
import { listRunningVvdConsolePorts } from "../../utils/vega-process";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";
import { discoverChromiumDevices, type ChromiumDevice } from "../../utils/chromium-discovery";
import {
  listVegaDevices,
  filterVvdShadowsFromAndroid,
  type VegaDevice,
} from "../../utils/vega-devices";
type IosDevice = IosSimulator & { platform: "ios" };

type AndroidDevice = {
  platform: "android";
  serial: string;
  state: string;
  isEmulator: boolean;
  // "emulator" for a local AVD, "device" for a physical phone (USB or wireless
  // adb). The two are driven by different simulator-server controllers, so the
  // kind is surfaced here for parity with iOS terminology and so consumers can
  // tell a connected phone apart from an emulator at a glance.
  kind: "emulator" | "device";
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
};

type ListDevicesResult = {
  devices: Array<IosDevice | AndroidDevice | ChromiumDevice | VegaDevice>;
  avds: Array<{ name: string }>;
};

function sortIos(a: IosDevice, b: IosDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  if (aBooted !== bBooted) return aBooted - bBooted;
  const aIpad = a.name.includes("iPad") ? 1 : 0;
  const bIpad = b.name.includes("iPad") ? 1 : 0;
  return aIpad - bIpad;
}

function sortAndroid(a: AndroidDevice, b: AndroidDevice): number {
  const aReady = a.state === "device" ? 0 : 1;
  const bReady = b.state === "device" ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  const aEmu = a.isEmulator ? 0 : 1;
  const bEmu = b.isEmulator ? 0 : 1;
  return aEmu - bEmu;
}

// Float booted/ready devices to the top of the merged list regardless of
// platform — without this, all iOS entries are emitted before any Android.
function readinessRank(d: IosDevice | AndroidDevice | ChromiumDevice | VegaDevice): number {
  if (d.platform === "ios") return d.state === "Booted" ? 0 : 1;
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  if (d.platform === "vega") return d.state === "running" || d.state === "device" ? 0 : 1;
  return 0; // Chromium entries are only listed when their CDP is responsive
}

// A running VVD also shows on adb as `emulator-<consolePort>` (or `127.0.0.1:<port+1>`
// after `adb connect`). Drop the adb row(s) whose console port matches a running VVD
// (from the process table); a real emulator / physical device sits elsewhere and stays.
async function resolveVvdShadowAdbSerials<T extends { serial: string }>(
  androidDevices: readonly T[],
  vega: readonly VegaDevice[]
): Promise<Set<string>> {
  // Nothing to dedup unless a VVD is actually running — skip the `ps` spawn on the
  // common (no-Vega) path; list-devices is alwaysLoad and called often.
  if (!vega.some((d) => d.kind === "vvd" && d.state === "running")) return new Set();
  const vvdPorts = await listRunningVvdConsolePorts();
  if (vvdPorts.size === 0) return new Set();
  const shadows = new Set<string>();
  for (const d of androidDevices) {
    const port = consolePortFromAdbSerial(d.serial);
    if (port !== null && vvdPorts.has(port)) shadows.add(d.serial);
  }
  return shadows;
}

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  description: `List iOS simulators, Android emulators, connected physical Android devices, running Chromium apps, and Vega (Fire TV) devices in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android/Vega entries, 'id' for Chromium) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios', 'android', 'chromium', or 'vega'); 'avds' lists Android AVDs bootable via boot-device. A Vega VVD is listed under 'devices' whether running or stopped (state 'running'/'stopped'); start a stopped one with boot-device using its 'vvdImage'.
Android entries also carry a 'kind' ('emulator' for a local AVD, 'device' for a physical phone connected over USB / wireless adb) — physical phones are detected from \`adb devices\` (any serial that is not an \`emulator-*\` one) and are driven through the same interaction tools as emulators; they do not need boot-device (just connect the phone with USB debugging authorised).
Chromium apps are discovered by probing CDP debugging ports (default 9222; extend via the ARGENT_CHROMIUM_PORTS=<comma-separated-ports> env var). They must already be running with --remote-debugging-port=<port> — use boot-device with electronAppPath to launch one.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select, Android platform-tools, or the Vega SDK is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium vega app fire tv session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const [ios, android, avds, chromium, vega] = await Promise.all([
      listIosSimulators(),
      listAndroidDevices().catch(() => []),
      listAvds(),
      discoverChromiumDevices().catch(() => []),
      listVegaDevices().catch(() => []),
    ]);
    const iosTagged: IosDevice[] = ios.map((s) => ({ platform: "ios", ...s }));
    iosTagged.sort(sortIos);
    const androidTagged: AndroidDevice[] = android.map((d) => ({
      platform: "android",
      serial: d.serial,
      state: d.state,
      isEmulator: d.isEmulator,
      kind: d.isEmulator ? "emulator" : "device",
      model: d.model,
      avdName: d.avdName,
      sdkLevel: d.sdkLevel,
    }));
    // Drop a running VVD's adb shadow row so it appears only once (as vega).
    const vvdShadowSerials = await resolveVvdShadowAdbSerials(androidTagged, vega);
    const androidDeduped = filterVvdShadowsFromAndroid(androidTagged, vvdShadowSerials);
    androidDeduped.sort(sortAndroid);

    const devices: Array<IosDevice | AndroidDevice | ChromiumDevice | VegaDevice> = [
      ...iosTagged,
      ...androidDeduped,
      ...chromium,
      ...vega,
    ];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    return { devices, avds };
  },
};

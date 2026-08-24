import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  listAndroidDevices,
  listAvds,
  consolePortFromAdbSerial,
  ADB_DEVICES_TIMEOUT_MS,
} from "../../utils/adb";
import { listRunningVvdConsolePorts } from "../../utils/vega-process";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";
import { simctlListDevices } from "../../utils/sim-remote";
import { withRemotePrefix } from "../../utils/device-info";
import { discoverChromiumDevices, type ChromiumDevice } from "../../utils/chromium-discovery";
import {
  listVegaDevices,
  filterVvdShadowsFromAndroid,
  type VegaDevice,
} from "../../utils/vega-devices";
type IosDevice = IosSimulator & { platform: "ios" };

type IosRemoteDevice = {
  platform: "ios-remote";
  udid: string;
  name: string;
  state: string;
  runtime: string;
};

type AndroidDevice = {
  platform: "android";
  serial: string;
  state: string;
  isEmulator: boolean;
  // Mirrors the emulator/phone split that selects the simulator-server
  // controller — see `isAndroidEmulatorSerial` in utils/device-info.ts.
  kind: "emulator" | "device";
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
  runtimeKind?: "mobile" | "tv";
};

type ListDevicesResult = {
  devices: Array<IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice | VegaDevice>;
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

// Floats booted/ready devices to the top across platforms; the merged array is
// otherwise ordered iOS-first.
function readinessRank(
  d: IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice | VegaDevice
): number {
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  if (d.platform === "vega") return d.state === "running" || d.state === "device" ? 0 : 1;
  if (d.platform === "chromium") return 0; // Chromium entries are only listed when their CDP is responsive
  return d.state === "Booted" ? 0 : 1; // ios + ios-remote
}

/**
 * Remote iOS simulators via `sim-remote`. Returns [] when the CLI is missing or
 * logged out — list-devices reports an unavailable platform as absent, not as an error.
 */
async function listRemoteIosSimulators(): Promise<IosRemoteDevice[]> {
  try {
    const result = await simctlListDevices();
    const out: IosRemoteDevice[] = [];
    for (const [runtime, devices] of Object.entries(result.devices)) {
      for (const d of devices) {
        if (d.isAvailable === false) continue;
        out.push({
          platform: "ios-remote",
          udid: withRemotePrefix(d.udid),
          name: d.name,
          state: d.state,
          runtime,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function sortIosRemote(a: IosRemoteDevice, b: IosRemoteDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  return aBooted - bBooted;
}

// A running VVD also shows on adb as `emulator-<consolePort>` (or `127.0.0.1:<port+1>`
// after `adb connect`); match those rows by console port against the process table.
async function resolveVvdShadowAdbSerials<T extends { serial: string }>(
  androidDevices: readonly T[],
  vega: readonly VegaDevice[]
): Promise<Set<string>> {
  // Skip the `ps` spawn on the common no-Vega path; list-devices is alwaysLoad.
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

// Last-resort backstop so no single discovery branch can stall this `alwaysLoad`
// tool. Every branch is already bounded by its own subprocess timeouts; this only
// catches an unforeseen stall (an OS-level spawn hang, a future call added with no
// timeout), degrading to a partial list the way `.catch(() => [])` degrades on error.
//
// It must sit ABOVE every branch's full worst case, or it stops being a last resort
// and truncates branches that would have completed, dropping real devices. The long
// pole is Vega at ~20s (6s `device list` + two serial 5s `ps` probes + 4s `device
// info` on the recovery path); Android is ~11s; iOS / AVD-list / Chromium are far
// below. list-devices-deadline.test.ts asserts the margin from the same exported
// constants, so a future timeout bump fails loudly instead of silently breaching it.
//
// This is a deadline, not cancellation: on timeout the fallback resolves while the
// branch keeps running, settling shortly after once its own timeouts fire.
export const BRANCH_DEADLINE_MS = 25_000;

export async function withDeadline<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          process.stderr.write(
            `[list-devices] ${label} discovery exceeded ${BRANCH_DEADLINE_MS}ms; ` +
              `returning partial results (a wedged device or its CLI is unresponsive)\n`
          );
          resolve(fallback);
        }, BRANCH_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  interaction: {
    startedMsg: () => "Listing devices",
    completedMsg: ({ result }) => {
      const deviceLabel = result.devices.length === 1 ? "device" : "devices";
      const avdLabel = result.avds.length === 1 ? "AVD" : "AVDs";
      return `Listed ${result.devices.length} ${deviceLabel} and ${result.avds.length} ${avdLabel}`;
    },
    failedMsg: ({ failureSignal }) => `Failed to list devices: ${failureSignal.error_code}`,
  },
  description: `List iOS simulators, Android emulators, connected physical Android devices, running Chromium apps, and Vega (Fire TV) devices in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android/Vega entries, 'id' for Chromium) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios', 'android', 'chromium', or 'vega'); 'avds' lists Android AVDs bootable via boot-device. A Vega VVD is listed under 'devices' whether running or stopped (state 'running'/'stopped'); start a stopped one with boot-device using its 'vvdImage'.
Android entries also carry a 'kind' ('emulator' for a local AVD, 'device' for a physical phone connected over USB / wireless adb) — physical phones are detected from \`adb devices\` (any serial that is not an \`emulator-*\` one) and are driven through the same interaction tools as emulators; they do not need boot-device (just connect the phone with USB debugging authorised).
TV targets are tagged with runtimeKind 'tv' (Apple TV simulators on iOS, Android TV / leanback devices on Android) — these are focus-driven, not touch-driven: use \`describe\` to read focus, \`tv-remote\` for remote presses (up/down/left/right/select/back/menu/home), and \`keyboard\` to type, rather than the coordinate/gesture tools.
iOS simulators from an additional CoreSimulator device set (the 'ios.additionalDeviceSets' configuration — e.g. devices created by Radon IDE) are listed alongside default-set ones, tagged with their owning 'deviceSet' path; they are driven through the same tools by udid, but run headless (no Simulator.app window attaches to them).
Chromium apps are discovered by probing CDP debugging ports (default 9222; extend via the ARGENT_CHROMIUM_PORTS=<comma-separated-ports> env var). They must already be running with --remote-debugging-port=<port> — use boot-device with electronAppPath to launch one.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select, Android platform-tools, or the Vega SDK is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium vega app fire tv session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    // Wrapping even the already-self-bounded iOS / AVD-list / Chromium branches makes
    // the "no branch can hang the fan-out" guarantee universal. The deadline only
    // substitutes a fallback on *slowness*; a rejection still propagates, so the
    // `.catch(() => [])` wrappers (and the lack of one on iOS/AVDs) are unchanged.
    const [ios, iosRemote, android, avds, chromium, vega] = await Promise.all([
      withDeadline(listIosSimulators(), [], "ios"),
      withDeadline(listRemoteIosSimulators(), [], "ios-remote"),
      withDeadline(
        // list-devices is the one caller that surfaces TV vs mobile, so it pays for
        // runtimeKind's extra per-device probe. The explicit `adb devices` bound
        // (not runAdb's 30s default) keeps this branch under BRANCH_DEADLINE_MS.
        listAndroidDevices({ runtimeKind: true, devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS }).catch(
          () => []
        ),
        [],
        "android"
      ),
      withDeadline(listAvds(), [], "avds"),
      withDeadline(
        discoverChromiumDevices().catch(() => []),
        [],
        "chromium"
      ),
      withDeadline(
        listVegaDevices().catch(() => []),
        [],
        "vega"
      ),
    ]);
    const iosTagged: IosDevice[] = ios.map((s) => ({ platform: "ios", ...s }));
    iosTagged.sort(sortIos);
    iosRemote.sort(sortIosRemote);
    const androidTagged: AndroidDevice[] = android.map((d) => ({
      platform: "android",
      serial: d.serial,
      state: d.state,
      isEmulator: d.isEmulator,
      kind: d.isEmulator ? "emulator" : "device",
      model: d.model,
      avdName: d.avdName,
      sdkLevel: d.sdkLevel,
      runtimeKind: d.runtimeKind,
    }));
    // Drop a running VVD's adb shadow row so it appears only once (as vega).
    const vvdShadowSerials = await resolveVvdShadowAdbSerials(androidTagged, vega);
    const androidDeduped = filterVvdShadowsFromAndroid(androidTagged, vvdShadowSerials);
    androidDeduped.sort(sortAndroid);

    const devices: Array<
      IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice | VegaDevice
    > = [...iosTagged, ...iosRemote, ...androidDeduped, ...chromium, ...vega];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    return { devices, avds };
  },
};

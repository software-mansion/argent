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
  // "emulator" for a local AVD, "device" for a physical phone (USB or wireless
  // adb). The two are driven by different simulator-server controllers, so the
  // kind is surfaced here for parity with iOS terminology and so consumers can
  // tell a connected phone apart from an emulator at a glance.
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

// Float booted/ready devices to the top of the merged list regardless of
// platform — without this, all iOS entries are emitted before any Android.
function readinessRank(
  d: IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice | VegaDevice
): number {
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  if (d.platform === "vega") return d.state === "running" || d.state === "device" ? 0 : 1;
  if (d.platform === "chromium") return 0; // Chromium entries are only listed when their CDP is responsive
  return d.state === "Booted" ? 0 : 1; // ios + ios-remote
}

/**
 * List remote iOS simulators via `sim-remote`. Returns [] (silently) if
 * sim-remote isn't installed or the user isn't logged in — list-devices
 * already treats CLI absence as "platform unavailable" rather than failing.
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

// Hard backstop so no single discovery branch can stall this `alwaysLoad` tool,
// which runs at session start and frequently after. The per-call subprocess
// timeouts (and the no-stacking fix in listVegaDevices) already bound each
// branch; this is defence-in-depth against an *unforeseen* stall — an OS-level
// spawn hang, a future serial call added with no timeout — so the worst case is a
// partial list with a logged note, never a 40s "hang". Mirrors the existing
// `.catch(() => [])` degradation, just for slowness rather than errors.
//
// Critically this must sit ABOVE every branch's full per-call worst case, or it
// stops being a last-resort backstop and starts truncating branches that would
// have completed — dropping a real device from the list. Summing each branch's
// own bounded subprocess calls (an invariant test in list-devices-deadline.test.ts
// guards these so a future timeout bump can't silently breach the deadline):
//   - Vega (the long pole): a non-timeout `device list` failure or an empty list
//     that triggers the `device info` recovery runs, serially, the 6s list timeout
//     + TWO 5s `ps` probes (the recovery gate in listVegaDevices plus the
//     `-d emulator-<port>` selector probe inside runVegaDevice) + the 4s `device
//     info` timeout = ~20s worst case. (A *timed-out* list skips the recovery
//     entirely — see listVegaDevices — so the wedged-VVD case is just ~6s.)
//   - Android: one bounded `adb devices` call (6s) + ~5s concurrent getprop
//     enrichment = ~11s.
//   - iOS: waits up to 12s for another argent process' host-wide simctl-list lock
//     and then runs a 10s bounded `simctl list devices` probe — still under 25s.
//   - AVD-list / Chromium self-bound by their own subprocess/socket timeouts
//     (AVD-list ~5s, Chromium <1s) — both comfortably under 25s.
// The Vega binary resolution (`resolveVegaBinary`) runs first but is memoized and
// returns the instant `vega` is found, so it adds ~0 in practice; only a pathological
// cold-session `command -v` shell-fork hang would add up to ~4s on top of the 20s,
// still inside the deadline. 25s clears the ~20s Vega long pole with margin, so a
// branch merely hitting its own (foreseen) per-call timeouts always completes rather
// than being cut off; only a genuinely unforeseen hang reaches the backstop. Still
// well below the ~40s stall this whole fix targets. The two Vega `ps` reads are local
// process-table reads (never a device round-trip), so this 20s figure is a
// pathological host-load ceiling, not the realistic wedged-device cost (~6s).
//
// Note: this is a *deadline*, not cancellation — on timeout it resolves the
// fallback while the underlying branch keeps running to completion in the
// background. That's fine here because the per-call subprocess timeouts bound the
// branch, so it settles shortly after rather than leaking work indefinitely.
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
  description: `List iOS simulators, Android emulators, connected physical Android devices, running Chromium apps, and Vega (Fire TV) devices in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android/Vega entries, 'id' for Chromium) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios', 'android', 'chromium', or 'vega'); 'avds' lists Android AVDs bootable via boot-device. A Vega VVD is listed under 'devices' whether running or stopped (state 'running'/'stopped'); start a stopped one with boot-device using its 'vvdImage'.
Android entries also carry a 'kind' ('emulator' for a local AVD, 'device' for a physical phone connected over USB / wireless adb) — physical phones are detected from \`adb devices\` (any serial that is not an \`emulator-*\` one) and are driven through the same interaction tools as emulators; they do not need boot-device (just connect the phone with USB debugging authorised).
TV targets are tagged with runtimeKind 'tv' (Apple TV simulators on iOS, Android TV / leanback devices on Android) — these are focus-driven, not touch-driven: use \`describe\` to read focus, \`tv-remote\` for remote presses (up/down/left/right/select/back/menu/home), and \`keyboard\` to type, rather than the coordinate/gesture tools.
Chromium apps are discovered by probing CDP debugging ports (default 9222; extend via the ARGENT_CHROMIUM_PORTS=<comma-separated-ports> env var). They must already be running with --remote-debugging-port=<port> — use boot-device with electronAppPath to launch one.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select, Android platform-tools, or the Vega SDK is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium vega app fire tv session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    // Every branch gets the same hard deadline so no single one can stall this
    // `alwaysLoad` tool. The Android/Vega branches are the ones that actually shell
    // out to potentially-wedged devices; iOS / AVD-list / Chromium already self-bound
    // with their own short subprocess/socket timeouts, but wrapping them too makes the
    // "no branch can hang the fan-out" guarantee universal at near-zero cost (the
    // timer is cleared on the fast happy path). Branch-level discovery failures
    // degrade to that branch's empty result so one platform issue does not hide
    // working devices from the others.
    const [ios, iosRemote, android, avds, chromium, vega] = await Promise.all([
      withDeadline(
        listIosSimulators().catch(() => []),
        [],
        "ios"
      ),
      withDeadline(listRemoteIosSimulators(), [], "ios-remote"),
      withDeadline(
        // Opt into runtimeKind enrichment (list-devices surfaces TV vs mobile to
        // the agent, so the extra feature probe per device is warranted here — the
        // boot-loop poller deliberately omits it), and pass the tight `adb devices`
        // bound (NOT boot-device's 30s default) so the Android branch self-bounds
        // under BRANCH_DEADLINE_MS — see ADB_DEVICES_TIMEOUT_MS.
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

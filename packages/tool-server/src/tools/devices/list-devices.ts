import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  listAndroidDevices,
  isFoldableAvd,
  listAvds,
  consolePortFromAdbSerial,
  readEmulatorConsoleAvdName,
  ADB_DEVICES_TIMEOUT_MS,
  type AndroidDevice as AdbAndroidDevice,
} from "../../utils/adb";
import { adbCommandPrefix } from "../../utils/adb-server";
import { listRunningVvdConsolePorts } from "../../utils/vega-process";
import {
  checkFoldableSimulator,
  scanIosSimulators,
  simctlListTimeoutAdvice,
  simulatorRuntimeKind,
  type IosSimulator,
} from "../../utils/ios-devices";
import { listIosPhysicalDevices } from "../../utils/ios-device/devicectl";
import { xcodeFirstLaunchHint, xcodeFirstLaunchPending } from "../../utils/xcode-first-launch";
import { simctlListDevices, simRemoteExecError } from "../../utils/sim-remote";
import { resolveAndroidBinary } from "../../utils/android-binary";
import {
  withRemotePrefix,
  harmonyDeviceId,
  harmonyEmulatorId,
  macosAppIdFromBundleId,
} from "../../utils/device-info";
import { listHarmonyInstances, listHarmonyHdcTargets } from "../../utils/harmony-devices";
import { isHarmonyEnabled } from "../../utils/harmony-flag";
import {
  isMacosAppsEnabled,
  listTrackedMacosApps,
  noListenSocketNote,
  trackedAppKind,
} from "../../utils/macos-apps";
import type { MacosAppKind } from "../../utils/macos-app-kind";
import { discoverChromiumDevices, type ChromiumDevice } from "../../utils/chromium-discovery";
import {
  listVegaDevices,
  filterVvdShadowsFromAndroid,
  type VegaDevice,
} from "../../utils/vega-devices";
import { listExternalDevices, type ExternalDevice } from "../../utils/external-devices";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type IosDevice = IosSimulator & { platform: "ios"; kind: "simulator" };

/**
 * A physical iPhone from CoreDevice (`xcrun devicectl`). Physical-device
 * support is iPhone-only for now; discovery skips iPads silently.
 */
type IosPhysicalDevice = {
  platform: "ios";
  kind: "device";
  udid: string;
  name: string;
  // connected = reachable over USB or the network; the tunnel comes up on first use. paired = remembered but unreachable.
  state: "connected" | "paired";
  runtime: string;
  model: string | null;
  developerModeEnabled: boolean | null;
  pairingState: string | null;
  transportType: string | null;
  // Not reachability. The CoreDevice tunnel can stay up over Wi-Fi after unplug.
  tunnelState: string | null;
};

type IosRemoteDevice = {
  platform: "ios-remote";
  kind: "simulator";
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
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
  /** Present, and true, for an emulator whose AVD profile has a hinge. */
  foldable?: true;
};

/**
 * `kind: "device"` is an `hdc` target (drivable); `kind: "emulator"` is a
 * DevEco instance (bootable). A running emulator is listed as both.
 */
type HarmonyDevice = {
  platform: "harmony";
  udid: string;
  name: string;
  kind: "emulator" | "device";
  /** `Connected`/`Offline` for a connected target; `running`/`stopped` for an instance. */
  state: string;
  deviceType?: string | null;
  osVersion?: string | null;
  connection?: string | null;
};

/**
 * A device an external provider is sharing. It carries a neutral `id` plus the
 * platform's conventional key (`udid` / `serial`), so an agent that learned
 * "iOS entries use udid" is not surprised. `provider` is deliberately visible:
 * it lets an agent pick the device belonging to its own project, and routes
 * bug reports to the right tracker.
 */
type ExternalListedDevice = {
  capabilities: string[];
  external: true;
  /**
   * Present and true for a foldable simulator (the iPhone Duo), as on a plain
   * iOS row.
   */
  foldable?: true;
  id: string;
  kind: "device" | "emulator" | "simulator";
  name: string;
  platform: "android" | "ios";
  provider: { id: string; name: string; workspace?: { name: string; path: string } };
  serial?: string;
  state: string;
  udid?: string;
};

/** A native Mac app that argent started and that still runs. */
type MacosAppDevice = {
  platform: "macos";
  /** `catalyst` for a Mac Catalyst app, `app` for an AppKit one. */
  kind: MacosAppKind;
  id: string;
  name: string;
  bundleId: string;
  appPath: string;
  pid: number;
  state: "Running";
  /** The app has no listening socket. */
  note?: string;
};

/**
 * An AVD that is not running. It has no serial until boot-device starts it; a
 * running AVD is listed only as its emulator.
 */
type AndroidAvdEntry = {
  platform: "android";
  kind: "avd";
  avdName: string;
  state: "stopped";
  foldable?: true;
};

type ChromiumListedDevice = ChromiumDevice & { kind: "app" };

type ListedDevice =
  | AndroidDevice
  | AndroidAvdEntry
  | ChromiumListedDevice
  | ExternalListedDevice
  | HarmonyDevice
  | IosDevice
  | IosPhysicalDevice
  | IosRemoteDevice
  | MacosAppDevice
  | VegaDevice;

type ListDevicesResult = {
  devices: ListedDevice[];
  /**
   * Present only when one applies, unlike the description, which is read once
   * per session: a platform this machine cannot reach and what would change
   * that, why local iOS targets are missing while Xcode's component install is
   * pending, a retry notice when `simctl` timed out, the rules for a provider's
   * device when one is listed, a retry notice when the foldable check of a
   * provider's simulator timed out, and how to reach the adb server when it is
   * not adb's default.
   */
  notes?: string[];
};

/** Argent Cloud through the `sim-remote` CLI, as far as list-devices can tell. */
type CloudState = "absent" | "logged-out" | "logged-in" | "unknown";

const ARGENT_CLOUD_URL = "https://argent.swmansion.com/cloud/";

const ARGENT_CLOUD_OFFER =
  `Argent Cloud, a hosted service that is not set up here, runs iOS simulators on remote Macs; ` +
  `once the user sets it up with their API key and the sim-remote CLI, they are listed as platform 'ios-remote'. ` +
  ARGENT_CLOUD_URL;

/**
 * Why no iOS target can appear, and what would change that. Only for a host
 * that cannot run local simulators, or when sim-remote waits for a login: on a
 * Mac with Xcode the note would be noise on every call.
 */
function iosReachNote(
  host: { localIos: boolean; darwin: boolean },
  cloud: CloudState
): string | null {
  if (cloud === "logged-out") {
    return (
      `iOS: ${host.localIos ? "" : "this machine cannot run iOS simulators locally; "}` +
      `sim-remote is installed but not logged in, so Argent Cloud simulators are not listed. ` +
      `The user runs \`sim-remote login\` in their own terminal.`
    );
  }
  if (cloud !== "absent" || host.localIos) return null;
  return host.darwin
    ? `iOS: no local simulators because \`simctl\` was not found in the active developer directory. Select your Xcode installation, or install Xcode if needed. ${ARGENT_CLOUD_OFFER}`
    : `iOS: this machine cannot run iOS simulators (they need macOS with Xcode). ${ARGENT_CLOUD_OFFER}`;
}

const ANDROID_SDK_MISSING_NOTE =
  "Android: no SDK found (adb, emulator). Installing the platform tools and creating an AVD adds Android targets.";

/** Only what differs from a device argent booted itself. */
const EXTERNAL_DEVICES_HINT =
  `Some entries are tagged 'external: true': another application is already driving that device, ` +
  `and its 'provider' field names it ('provider.workspace' names the project it opened, when it published one). ` +
  `Drive them with the usual tools, by the 'ext:'-prefixed id. Two rules differ: prefer the external device whose ` +
  `'provider.workspace.path' matches the project you are working in, and do NOT call boot-device on them, since the ` +
  `provider owns their lifecycle. stop-simulator-server IS safe on them and never stops the provider's server — it ` +
  `drops argent's cached handles, which is the recovery when calls keep failing against an endpoint the provider has ` +
  `since moved. Each entry's 'capabilities' lists the mechanisms that provider granted; a tool relying on one it ` +
  `withheld fails with a clear message naming the provider.`;

function foldableCheckTimedOutHint(names: readonly string[]): string {
  return (
    `The foldable check did not finish in time for ${names.join(", ")}, so 'foldable: true' may be ` +
    `missing there. Call list-devices again to retry the check.`
  );
}

function iosListTimedOutHint(): string {
  return `iOS simulators may be missing from this list: ${simctlListTimeoutAdvice("list-devices")}`;
}

/**
 * The agent's shell does not inherit the tool-server's environment, so its adb
 * reaches the default server, where these serials do not exist. Given whenever
 * the server differs, Android device or not: the agent may boot one next.
 */
function adbServerHint(prefix: string): string {
  return (
    `Argent reaches Android and Vega devices through an adb server other than adb's default, so ` +
    `an adb command you run in your own shell does not see the serials listed here. Prefix every ` +
    `adb command you run yourself: \`${prefix}adb -s <serial> ...\`.`
  );
}

function sortIos(a: IosDevice, b: IosDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  if (aBooted !== bBooted) return aBooted - bBooted;
  const aIpad = a.name.includes("iPad") ? 1 : 0;
  const bIpad = b.name.includes("iPad") ? 1 : 0;
  return aIpad - bIpad;
}

function sortAndroid(
  a: AndroidDevice | AndroidAvdEntry,
  b: AndroidDevice | AndroidAvdEntry
): number {
  const aReady = a.state === "device" ? 0 : 1;
  const bReady = b.state === "device" ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  return androidKindRank(a) - androidKindRank(b);
}

/** Running emulators, then phones, then AVDs that are not running. */
function androidKindRank(d: AndroidDevice | AndroidAvdEntry): number {
  return d.kind === "emulator" ? 0 : d.kind === "device" ? 1 : 2;
}

// Floats booted/ready devices to the top across platforms; the merged array is
// otherwise ordered iOS-first.
function readinessRank(d: ListedDevice): number {
  // Providers only advertise devices they are driving, each naming the state in
  // its own platform's vocabulary, so accept every "ready" spelling.
  if ("external" in d) {
    return d.state === "Booted" || d.state === "device" || d.state === "running" ? 0 : 1;
  }
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  if (d.platform === "vega") return d.state === "running" || d.state === "device" ? 0 : 1;
  if (d.platform === "chromium") return 0; // Chromium entries are only listed when their CDP is responsive
  // A `Connected` target or a `running` instance is ready.
  if (d.platform === "harmony") return d.state === "Connected" || d.state === "running" ? 0 : 1;
  if (d.platform === "macos") return 0; // Mac apps are only listed while their process runs
  // Physical iOS: paired-but-unreachable ranks with shut-down devices.
  if ("kind" in d && d.kind === "device") return d.state === "connected" ? 0 : 1;
  return d.state === "Booted" ? 0 : 1; // ios + ios-remote
}

/**
 * Remote iOS simulators via `sim-remote`, with the CLI's state. A missing CLI or
 * a logged-out session lists nothing and is reported through a note, not as an
 * error; any other failure lists nothing and says nothing.
 */
async function listRemoteIosSimulators(): Promise<{
  devices: IosRemoteDevice[];
  cloud: CloudState;
}> {
  try {
    const result = await simctlListDevices();
    const out: IosRemoteDevice[] = [];
    for (const [runtime, devices] of Object.entries(result.devices)) {
      const runtimeKind = simulatorRuntimeKind(runtime);
      if (!runtimeKind) continue;
      for (const d of devices) {
        if (d.isAvailable === false) continue;
        out.push({
          platform: "ios-remote",
          kind: "simulator",
          udid: withRemotePrefix(d.udid),
          name: d.name,
          state: d.state,
          runtime,
          runtimeKind,
        });
      }
    }
    return { devices: out, cloud: "logged-in" };
  } catch (err) {
    if ((simRemoteExecError(err) as { code?: unknown }).code === "ENOENT") {
      return { devices: [], cloud: "absent" };
    }
    const loggedOut = err instanceof Error && /not logged in/i.test(err.message);
    return { devices: [], cloud: loggedOut ? "logged-out" : "unknown" };
  }
}

/**
 * Whether this host can run iOS simulators at all. Only probed when the scan
 * found none, so a Mac with simulators pays nothing.
 */
async function canRunLocalIos(simulatorsFound: boolean): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (simulatorsFound) return true;
  return execFileAsync("xcrun", ["--find", "simctl"], { timeout: 5_000 }).then(
    () => true,
    () => false
  );
}

/**
 * adb lists an emulator as `offline` while it boots, before getprop can name its
 * AVD. Its console answers from the start, so ask it: otherwise the AVD would
 * also be listed as stopped and an agent could boot it a second time.
 */
async function nameBootingEmulators(devices: AdbAndroidDevice[]): Promise<AdbAndroidDevice[]> {
  return Promise.all(
    devices.map(async (d) => {
      if (!d.isEmulator || d.avdName !== null) return d;
      const answer = await readEmulatorConsoleAvdName(d.serial);
      return answer.status === "ok" ? { ...d, avdName: answer.avdName } : d;
    })
  );
}

async function androidSdkFound(): Promise<boolean> {
  const [adb, emulator] = await Promise.all([
    resolveAndroidBinary("adb"),
    resolveAndroidBinary("emulator"),
  ]);
  return adb !== null || emulator !== null;
}

async function listMacosApps(): Promise<MacosAppDevice[]> {
  if (process.platform !== "darwin" || !isMacosAppsEnabled()) return [];
  const apps = await listTrackedMacosApps();
  return apps.map((app) => ({
    platform: "macos",
    kind: trackedAppKind(app),
    id: macosAppIdFromBundleId(app.bundleId),
    name: app.name,
    bundleId: app.bundleId,
    appPath: app.appPath,
    pid: app.pid,
    state: "Running",
    ...(app.listenSocket ? {} : { note: noListenSocketNote(app.bundleId) }),
  }));
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
// info` on the recovery path); Android is ~11s; the two HarmonyOS branches run
// concurrently and top out at the 8s `hdc list targets`; the external branch is
// ~6s (0.8s liveness probe + the 5s foldable budget); iOS / AVD-list / Chromium
// are far below. list-devices-deadline.test.ts asserts the margin from the same
// exported constants, so a future timeout bump fails loudly instead of silently
// breaching it.
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

function toListedExternal(device: ExternalDevice, foldable: boolean): ExternalListedDevice {
  return {
    capabilities: Array.from(device.capabilities).sort(),
    external: true,
    ...(foldable ? { foldable: true as const } : {}),
    id: device.id,
    kind: device.kind,
    name: device.name,
    platform: device.platform,
    provider: {
      id: device.provider.id,
      name: device.provider.name,
      ...(device.provider.workspace ? { workspace: device.provider.workspace } : {}),
    },
    state: device.state,
    /** Mirror the id into the key the agent associates with the platform. */
    ...(device.platform === "ios" ? { udid: device.id } : { serial: device.id }),
  };
}

/**
 * `foldableTimedOut`: the foldable check ran past its budget or the listing of
 * the provider's device set timed out, so `foldable` is unknown.
 */
type ExternalEntry = { device: ExternalDevice; foldable: boolean; foldableTimedOut: boolean };

/**
 * How long the external branch waits for the foldable check of its lent
 * simulators. The check reads the provider's device set and (the first time a
 * device type is seen) the device-type list and profile. Each of those `simctl`
 * and `plutil` calls has its own timeout and in series they can outlast
 * `BRANCH_DEADLINE_MS`, which would drop every lent device, Android ones
 * included. Past this budget or when the listing of the set times out inside
 * it, a lent simulator is listed without the flag and a note in the result
 * says so. The check keeps running and caches what it finds, so a later call
 * gets the flag once the device set answers in time.
 */
export const EXTERNAL_FOLDABLE_BUDGET_MS = 5_000;

/**
 * Pair each external device with whether it is a foldable simulator (the iPhone
 * Duo), read from the provider's device set. An agent needs the flag to know
 * `fold` applies, whoever drives the device. This runs inside the external
 * discovery branch, after the liveness probe, so it overlaps the other
 * branches. The branch's worst case is the probe plus
 * {@linkcode EXTERNAL_FOLDABLE_BUDGET_MS}, under
 * {@linkcode BRANCH_DEADLINE_MS}. {@linkcode checkFoldableSimulator} memoizes
 * every verdict the device set answers, so a simulator the set lists costs one
 * `simctl` call per tool-server run.
 */
async function withFoldableFlags(external: readonly ExternalDevice[]): Promise<ExternalEntry[]> {
  const simulators = external.filter(
    (device) => device.platform === "ios" && device.kind === "simulator"
  );

  if (simulators.length === 0) {
    return external.map((device) => ({ device, foldable: false, foldableTimedOut: false }));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const budget = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), EXTERNAL_FOLDABLE_BUDGET_MS);
  });

  try {
    return await Promise.all(
      external.map(async (device) => {
        if (!simulators.includes(device)) {
          return { device, foldable: false, foldableTimedOut: false };
        }

        /**
         * A rejection (`XcodeFirstLaunchPendingError` while Xcode's component
         * install is pending) must not escape: the branch's own `.catch` runs
         * before this step, so it would fail the whole call.
         */
        const verdict = await Promise.race([
          checkFoldableSimulator(device.id).catch(() => false),
          budget,
        ]);

        return {
          device,
          foldable: verdict === true,
          foldableTimedOut: verdict === "timed-out",
        };
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Native ids a provider is currently claiming.
 *
 * The same device reaches this tool twice whenever the platform's own
 * discovery can also see it: `adb devices` always sees a provider's emulator,
 * and `simctl` sees its simulators once the provider's device set is listed in
 * `ios.additionalDeviceSets`. Drop the plain row in both cases, the external
 * entry is the one carrying the provider's attribution and capability grants,
 * and driving the bare id would spawn a second simulator-server against a
 * device already in use.
 */
function externalShadowIds(external: readonly ExternalDevice[]): Set<string> {
  return new Set(external.map((device) => device.nativeId));
}

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  description: `List the targets argent can drive or start: iOS simulators and iPhones, Android emulators, AVDs and phones, Chromium (CDP) apps, Vega (Fire TV) devices, <flag:harmonyos>HarmonyOS phones and emulators, </flag:harmonyos><flag:macos-apps>Mac apps argent started, </flag:macos-apps>and iOS simulators hosted on Argent Cloud.
Returns { devices, notes? }. Each device has a 'platform', a 'kind' and a 'state'. Pass its 'udid' (iOS<flag:harmonyos>, HarmonyOS</flag:harmonyos>), 'serial' (Android, Vega) or 'id' (Chromium<flag:macos-apps>, Mac app</flag:macos-apps>) to the other tools. Ready devices come first.
Start a stopped device with boot-device: an iOS simulator by 'udid', an Android AVD (kind 'avd', no serial until it runs) by 'avdName', a Vega VVD by 'vvdImage'. A physical phone (kind 'device') needs no boot; use one only when the user asks for it. A physical iPhone is usable only in state 'connected'.
<flag:harmonyos>HarmonyOS kind 'device' is an \`hdc\` target that the tools drive; kind 'emulator' is a DevEco Studio instance that boot-device starts, and a running one is listed as both.
</flag:harmonyos>platform 'ios-remote' is an iOS simulator hosted on Argent Cloud, usable from Linux too (https://argent.swmansion.com/cloud/); drive it with the same tools by its 'remote:' udid. A 'deviceSet' simulator (e.g. from Radon IDE) runs headless.
runtimeKind 'tv' marks a focus-driven TV target: use describe, tv-remote and keyboard, not gestures. 'foldable: true' marks a device the fold tool folds.
Chromium apps are found on CDP port 9222 (more via ARGENT_CHROMIUM_PORTS); boot-device with electronAppPath launches one.
'notes' says which platform this machine cannot reach and what would change that; tell the user when their task needs that platform.`,
  zodSchema,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium vega <flag:harmonyos>harmony harmonyos </flag:harmonyos>app fire tv session start",
  readOnly: true,
  interaction: {
    startedMsg: () => "Listing devices",
    completedMsg: ({ result }) =>
      `Listed ${result.devices.length} ${result.devices.length === 1 ? "device" : "devices"}`,
    failedMsg: ({ failureSignal }) => `Failed to list devices: ${failureSignal.error_code}`,
  },
  services: () => ({}),
  async execute(_services, _params) {
    const harmonyEnabled = isHarmonyEnabled();
    const xcodeInstallPending = (["simctl", "devicectl"] as const).filter(xcodeFirstLaunchPending);
    // Wrapping even the already-self-bounded iOS / AVD-list / Chromium branches makes
    // the "no branch can hang the fan-out" guarantee universal. The deadline only
    // substitutes a fallback on *slowness*; a rejection still propagates, so the
    // `.catch(() => [])` wrappers (and the lack of one on iOS/AVDs) are unchanged.
    const [
      ios,
      iosPhysical,
      iosRemote,
      android,
      avds,
      chromium,
      vega,
      harmony,
      harmonyTargets,
      external,
      macos,
    ] = await Promise.all([
      xcodeInstallPending.includes("simctl")
        ? { simulators: [], timedOut: false }
        : withDeadline(scanIosSimulators(), { simulators: [], timedOut: true }, "ios"),
      withDeadline(
        listIosPhysicalDevices().catch(() => []),
        [],
        "ios-physical"
      ),
      withDeadline(
        listRemoteIosSimulators(),
        { devices: [], cloud: "unknown" as CloudState },
        "ios-remote"
      ),
      withDeadline(
        // list-devices is the one caller that surfaces TV vs mobile, so it pays for
        // runtimeKind's extra per-device probe. The explicit `adb devices` bound
        // (not runAdb's 30s default) keeps this branch under BRANCH_DEADLINE_MS.
        listAndroidDevices({ runtimeKind: true, devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS })
          .then(nameBootingEmulators)
          .catch(() => []),
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
      harmonyEnabled
        ? withDeadline(
            listHarmonyInstances().catch(() => []),
            [],
            "harmony"
          )
        : [],
      harmonyEnabled
        ? withDeadline(
            listHarmonyHdcTargets().catch(() => []),
            [],
            "harmony-hdc"
          )
        : [],
      /**
       * One directory stat when no provider is registered (the common case)
       * and a short HTTP probe per provider otherwise, then the foldable
       * check of each lent simulator.
       */
      withDeadline(
        listExternalDevices()
          .catch(() => [])
          .then(withFoldableFlags),
        [],
        "external"
      ),
      withDeadline(
        listMacosApps().catch(() => []),
        [],
        "macos"
      ),
    ]);

    const externalShadows = externalShadowIds(external.map(({ device }) => device));

    const iosTagged: IosDevice[] = ios.simulators
      .filter((simulator) => !externalShadows.has(simulator.udid))
      .map((simulator) => ({ platform: "ios", kind: "simulator", ...simulator }));

    iosTagged.sort(sortIos);
    const iosPhysicalTagged: IosPhysicalDevice[] = iosPhysical
      .filter((d) => !externalShadows.has(d.udid))
      .map((d) => ({
        platform: "ios",
        kind: "device",
        udid: d.udid,
        name: d.name,
        state:
          d.transportType === "wired" || d.transportType === "localNetwork"
            ? "connected"
            : "paired",
        runtime: d.osVersion ? `iOS ${d.osVersion} (physical device)` : "iOS (physical device)",
        model: d.model,
        developerModeEnabled: d.developerModeEnabled,
        pairingState: d.pairingState,
        transportType: d.transportType,
        tunnelState: d.tunnelState,
      }));
    const iosRemoteSorted = [...iosRemote.devices].sort(sortIosRemote);
    // One config.ini read per AVD name, shared by the running emulators and the AVD list.
    const foldableAvds = new Set(
      (
        await Promise.all(
          [...new Set([...avds.map((a) => a.name), ...android.map((d) => d.avdName)])]
            .filter((name): name is string => name !== null)
            .map(async (name) => ((await isFoldableAvd(name)) ? name : null))
        )
      ).filter((name): name is string => name !== null)
    );
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
      ...(d.avdName !== null && foldableAvds.has(d.avdName) ? { foldable: true as const } : {}),
    }));
    // Drop a running VVD's adb shadow row so it appears only once (as vega),
    // and likewise any serial an external provider has claimed.
    const vvdShadowSerials = await resolveVvdShadowAdbSerials(androidTagged, vega);
    const shadowSerials = new Set([...vvdShadowSerials, ...externalShadows]);
    const androidDeduped = filterVvdShadowsFromAndroid(androidTagged, shadowSerials);
    // A running AVD is listed once, as its emulator; the rest can be booted by name.
    const runningAvds = new Set(android.map((d) => d.avdName).filter((n) => n !== null));
    const avdEntries: AndroidAvdEntry[] = avds
      .filter((a) => !runningAvds.has(a.name))
      .map((a) => ({
        platform: "android",
        kind: "avd",
        avdName: a.name,
        state: "stopped",
        ...(foldableAvds.has(a.name) ? { foldable: true as const } : {}),
      }));
    const androidListed: Array<AndroidDevice | AndroidAvdEntry> = [
      ...androidDeduped,
      ...avdEntries,
    ];
    androidListed.sort(sortAndroid);

    const harmonyTagged: HarmonyDevice[] = [
      ...harmonyTargets.map((t): HarmonyDevice => ({
        platform: "harmony",
        udid: harmonyDeviceId(t.connectKey),
        name: t.connectKey,
        kind: "device",
        state: t.state,
        connection: t.connection,
      })),
      ...harmony.map((h): HarmonyDevice => ({
        platform: "harmony",
        udid: harmonyEmulatorId(h.name),
        name: h.name,
        kind: "emulator",
        state: h.running ? "running" : "stopped",
        deviceType: h.deviceType,
        osVersion: h.osVersion,
      })),
    ];

    const devices: ListedDevice[] = [
      ...iosTagged,
      ...iosPhysicalTagged,
      ...iosRemoteSorted,
      ...androidListed,
      ...chromium.map(({ platform, ...rest }): ChromiumListedDevice => ({
        platform,
        kind: "app",
        ...rest,
      })),
      ...macos,
      ...vega,
      ...harmonyTagged,
      ...external.map(({ device, foldable }) => toListedExternal(device, foldable)),
    ];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    const [localIos, androidSdk] = await Promise.all([
      xcodeInstallPending.includes("simctl") ? true : canRunLocalIos(ios.simulators.length > 0),
      android.length > 0 || avds.length > 0 ? true : androidSdkFound(),
    ]);
    const iosNote = iosReachNote(
      { localIos, darwin: process.platform === "darwin" },
      iosRemote.cloud
    );

    const foldableTimedOut = external
      .filter((entry) => entry.foldableTimedOut)
      .map(({ device }) => device.name);

    const adbPrefix = adbCommandPrefix(process.env);
    const notes = [
      ...(iosNote ? [iosNote] : []),
      ...(androidSdk ? [] : [ANDROID_SDK_MISSING_NOTE]),
      ...(xcodeInstallPending.length > 0 ? [xcodeFirstLaunchHint(xcodeInstallPending)] : []),
      ...(ios.timedOut ? [iosListTimedOutHint()] : []),
      ...(external.length > 0 ? [EXTERNAL_DEVICES_HINT] : []),
      ...(foldableTimedOut.length > 0 ? [foldableCheckTimedOutHint(foldableTimedOut)] : []),
      ...(adbPrefix ? [adbServerHint(adbPrefix)] : []),
    ];

    return { devices, ...(notes.length > 0 ? { notes } : {}) };
  },
};

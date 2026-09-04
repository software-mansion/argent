import { execFile, spawn, type StdioOptions } from "node:child_process";
import { openSync, closeSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isFlagEnabled } from "@argent/configuration-core";
import {
  FAILURE_CODES,
  FailureError,
  ServiceNotFoundError,
  getFailureSignal,
  type Registry,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import {
  buildInitFailedResult,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";
import { ensureAutomationEnabled, setAccessibilityPrefsPreBoot } from "../../blueprints/ax-service";
import {
  adbShell,
  checkSnapshotLoadable,
  emulatorSupportsFlag,
  hasDefaultBootSnapshot,
  listAndroidDevices,
  listAvds,
  resolveEmulatorOrThrow,
  runAdb,
  waitForBootCompleted,
} from "../../utils/adb";
import { ensureDep } from "../../utils/check-deps";
import { linuxBootDiagnostics } from "../../utils/linux-preflight";
import { listIosSimulators } from "../../utils/ios-devices";
import { deviceSetForUdid, simctlPrefix } from "../../utils/ios-device-sets";
import { androidHeadlessFromEnv, iosHeadlessFromEnv } from "../../utils/no-window-env";
import {
  classifyDevice,
  harmonyInstanceName,
  stripRemotePrefix,
  harmonyDeviceId,
  harmonyEmulatorId,
} from "../../utils/device-info";
import {
  simctlBoot as simRemoteBoot,
  simctlBootstatus as simRemoteBootstatus,
  simctlListDevices as simRemoteListDevices,
  simctlShutdown as simRemoteShutdown,
} from "../../utils/sim-remote";
import { listVvdImages } from "../../utils/vega-sdk";
import { startVvd, stopVvd, isVvdRunning, waitForVvdRunning } from "../../utils/vega-vvd";
import { resolveRunningVvdSerial, listVegaDevices } from "../../utils/vega-devices";
import {
  EMULATOR_NOT_FOUND,
  EMULATOR_TIMEOUT_MS,
  emulatorFailure,
  isChinaOnlyRestriction,
  resolveHarmonyEmulator,
  runHarmonyEmulator,
} from "../../utils/harmony-cli";
import {
  HARMONY_LIST_TIMEOUT_MS,
  HDC_LIST_TIMEOUT_MS,
  listHarmonyHdcTargetsStrict,
  listHarmonyInstances,
} from "../../utils/harmony-devices";
import { resolveHdc } from "../../utils/harmony-hdc";
import { UITEST_TIMEOUT_MS, harmonyDisplay, harmonyDumpLayout } from "../../utils/harmony-uitest";
import { bootElectronApp, type ElectronBootResult } from "./boot-electron";

const execFileAsync = promisify(execFile);

// The exactly-one check over `udid`/`avdName`/`vvdImage`/`harmonyInstance`/`electronAppPath`
// lives in `execute`, so each field's `.describe()` restates the constraint for MCP clients.
const zodSchema = z.object({
  udid: z
    .string()
    .optional()
    .describe(
      "iOS: simulator UDID to boot (from `list-devices`). Provide exactly one of `udid`, `avdName`, `vvdImage`, `harmonyInstance`, or `electronAppPath`."
    ),
  avdName: z
    .string()
    .optional()
    .describe(
      "Android: AVD name to launch a new emulator from (from `list-devices` → `avds[].name`). Provide exactly one of `udid`, `avdName`, `vvdImage`, `harmonyInstance`, or `electronAppPath`."
    ),
  vvdImage: z
    .string()
    .optional()
    .describe(
      "Vega (Fire TV): VVD image to boot — the `vvdImage` of a Vega device from `list-devices` (e.g. `tv`). Starts the single SDK-managed Vega Virtual Device. Provide exactly one of `udid`, `avdName`, `vvdImage`, `harmonyInstance`, or `electronAppPath`."
    ),
  harmonyInstance: z
    .string()
    .optional()
    .describe(
      'HarmonyOS: emulator instance to start — the `name` of a `kind: "emulator"` device from `list-devices` (e.g. `Phone_1`); the `harmony-emulator-<name>` id that entry reports as its `udid` is accepted too. Provide exactly one of `udid`, `avdName`, `vvdImage`, `harmonyInstance`, or `electronAppPath`.'
    ),
  bootTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .optional()
    .describe(
      "Android/Vega/HarmonyOS: overall budget for the boot sequence. Default 480000 (8 min) on Android, 120000 (2 min) on Vega, 180000 (3 min) on HarmonyOS, where with `force` it spans the shutdown as well as the boot. Clamped to [30s, 15min]. Ignored on iOS."
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Shut down and re-boot the device even if already running. On HarmonyOS it is also what ties an already-running instance to the `hdc` connect key it registered under, since the emulator manager never reports one: without it the instance is left alone and the payload names the instance rather than a key (`list-devices` lists the keys, but not which instance each belongs to). Ignored for Electron, which always spawns a fresh process."
    ),
  sound: z
    .boolean()
    .optional()
    .describe(
      "Android only: boot the emulator with audio output enabled. Defaults to false — argent boots emulators MUTED so several agent-driven devices don't all play sound on the host machine; pass `true` when the task involves playing, hearing, or testing audio. Takes effect at boot: if the emulator is already running muted, add `force: true` to reboot it with sound. A boot snapshot saved in the other audio mode can't be reused, so the first boot after toggling is a slower cold boot. The `boot-sound` argent flag flips this default to true. Ignored on iOS/Vega/HarmonyOS/Electron, which argent never mutes."
    ),
  headless: z
    .boolean()
    .optional()
    .describe(
      "iOS only: boot the simulator core WITHOUT opening the Simulator.app GUI window. The device still streams via simulator-server; used by Argent Lens. Set the `ARGENT_SIMULATOR_NO_WINDOW` env var (1/true/yes) to force this host-wide without passing the flag per call (the iOS analog of `ARGENT_EMULATOR_NO_WINDOW`). Ignored on Android/Vega/HarmonyOS/Electron, which have no equivalent GUI step."
    ),
  electronAppPath: z
    .string()
    .optional()
    .describe(
      "Electron: path to the Electron app to launch. Either a packaged .app bundle / executable, or a project directory whose package.json points the Electron binary at the entry script. Provide exactly one of `udid`, `avdName`, `vvdImage`, `harmonyInstance`, or `electronAppPath`."
    ),
  electronPort: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .describe(
      "Electron-only: CDP remote-debugging port to expose. Defaults to a free port; the resulting device id is `chromium-cdp-<port>`."
    ),
  electronArgs: z
    .array(z.string())
    .optional()
    .describe(
      "Electron-only: extra CLI arguments forwarded to the Electron binary after the app path."
    ),
});

type BootDeviceParams = z.infer<typeof zodSchema>;

type BootDeviceResult =
  | { platform: "ios"; udid: string; booted: true }
  | { platform: "ios-remote"; udid: string; booted: true }
  | { platform: "android"; serial: string; avdName: string; booted: true }
  | VegaBootResult
  | HarmonyBootResult
  | ElectronBootResult
  | NativeDevtoolsInitFailedResult;

function bootTarget(params: BootDeviceParams): string {
  return (
    params.udid ??
    params.avdName ??
    params.vvdImage ??
    params.harmonyInstance ??
    params.electronAppPath ??
    "device"
  );
}

// Flags every boot-device launch passes (`-noaudio` unless the caller opts
// into sound — see launchHardeningArgs below). Performance: `-noaudio` skips
// guest pulseaudio init (one thread, ~50 MB RSS); `-no-boot-anim` skips the
// Pixel boot animation, a major CPU spike on software-rendered GPU modes;
// `-netfast` disables network shaping (latency/speed simulation), pure
// overhead for MCP use cases. Measured on a 4-core Skylake host with a
// 4096 MB / 228 MB-heap AVD: warm-cache cold boot drops 66 s → 49 s (~25%),
// qemu RSS at +20 s drops ~190 MB. android-emulator-runner (the canonical CI
// launcher) passes the same three by default for the same reasons.
//
// Dialog suppression: `-no-metrics` suppresses the metrics-collection consent
// dialog, which blocks the next boot until a human dismisses it. It is
// Google's anonymous emulator-usage telemetry and is unrelated to any argent
// profiler tool (those run guest-side via Perfetto/simpleperf or Metro CDP).
//
// All three are long-standing, documented emulator options (present in
// `emulator -help`) and are flag-only with no host detection, so they apply
// uniformly to macOS and Linux. The sibling dialog-suppression flag
// `-crash-report-mode never` is deliberately NOT here: it is missing from many
// builds (e.g. 36.1.9.0 answers `unknown option` for it) and an unrecognized
// option aborts the launch, so it is feature-detected per boot — see
// `crashReportArgs` in `bootAndroid`.
//
// `-noaudio` and `-netfast` change qemu device topology, so these must be
// passed identically to the snapshot probe, hot boot, and cold boot: a
// mismatch would silently invalidate the snapshot the previous cold boot saved.
const LAUNCH_HARDENING_ARGS = ["-no-boot-anim", "-netfast", "-no-metrics"] as const;

// `-noaudio` is opt-out rather than unconditional: the tool's `sound` argument
// (defaulted by the `boot-sound` flag) drops it so audio-testing sessions can
// hear the emulator. `sound` is fixed for the lifetime of one bootAndroid call,
// so probe / hot boot / cold boot still share one argv and the snapshot-parity
// invariant above holds; a snapshot saved in the other audio mode simply fails
// the loadability probe and falls through to a cold boot that re-saves it.
function launchHardeningArgs(sound: boolean): string[] {
  return sound ? [...LAUNCH_HARDENING_ARGS] : ["-noaudio", ...LAUNCH_HARDENING_ARGS];
}

// Per-stage sub-budgets so a hang in one stage cannot consume the entire
// overall budget.
const STAGE_BUDGET = {
  adbRegister: 60_000, // adb devices sees the serial for this AVD
  deviceReady: 180_000, // adb -s wait-for-device returns (state === "device")
  bootCompleted: 300_000, // sys.boot_completed = 1
  pmReady: 45_000, // pm path android answers (retried; non-fatal on the final attempt)
  firstRealFrame: 90_000,
  firstRealFrameHot: 8_000, // the sticky-blank state never clears on its own, so a
  // few seconds is enough to tell it from a transient blank.
} as const;

// `-gpu` values the emulator binary accepts (per `emulator -help-gpu`).
// Validated at boot-start so a typoed override fails immediately instead of
// after the emulator rejects it mid-launch.
const VALID_GPU_MODES = new Set([
  "auto",
  "host",
  "guest",
  "off",
  "swiftshader",
  "swiftshader_indirect",
  "angle",
  "angle_indirect",
  "angle9",
  "angle9_indirect",
  "swangle",
  "swangle_indirect",
]);

// Linux: `-gpu auto` lands on lavapipe (CPU Vulkan, large cold-boot
// regression) and `-gpu host` can produce a corrupted/black emulator window on
// dual-GPU, NVIDIA+Mesa, Wayland and containerized hosts while screencap-based
// screenshots still report success. `swiftshader` avoids both.
// `ARGENT_EMULATOR_GPU_MODE` overrides; macOS uses `auto`.
function selectGpuMode(): string {
  const override = process.env.ARGENT_EMULATOR_GPU_MODE;
  if (override && override.trim()) {
    const value = override.trim();
    if (!VALID_GPU_MODES.has(value)) {
      throw new FailureError(
        `ARGENT_EMULATOR_GPU_MODE=${JSON.stringify(value)} is not a known emulator -gpu value. ` +
          `Valid values: ${[...VALID_GPU_MODES].join(", ")}.`,
        {
          error_code: FAILURE_CODES.BOOT_ANDROID_GPU_MODE_INVALID,
          failure_stage: "boot_android_gpu_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    return value;
  }
  return process.platform === "linux" ? "swiftshader" : "auto";
}

// Poll cadences for the boot state machine: they bound latency, not
// correctness. Deliberately conservative so a hung adb on the default 30s
// timeout is not re-spawned every few ms.
const BOOT_POLL_INTERVALS_MS = {
  serialByAvd: 1_500, // findSerialByAvdName: re-scan when >1 new emulator appeared
  adbRegister: 1_000, // attemptBoot stage 2: re-scan adb devices for the new serial
  earlyExit: 500, // createEarlyExitRacer: re-check the crash latch during a blocking adb call
} as const;

// Probe shared by assertScreencapAlive (hot boot) and awaitFirstRealFrame
// (cold boot): `screencap -p` emits a PNG of the current frame and awk
// thresholds its byte count — real content is reliably >20 KB, a uniform-color
// frame deflates to a few KB at any resolution (see assertScreencapAlive for
// why raw-RGBA byte sniffing isn't sufficient). `wc -c` of empty input is "0",
// so a missing/failed screencap reads as failure rather than a silent pass.
// The leading literal token "screencap" keeps test mocks matching on it firing.
const FRAME_PROBE = "screencap -p 2>/dev/null | wc -c | awk '$1>20000{print 1;exit} {print 0}'";

async function killEmulatorQuietly(
  serial: string | null,
  child?: import("node:child_process").ChildProcess
): Promise<void> {
  // Preferred path: the emulator console's kill command drains pending writes,
  // including a mid-save ram.bin, before qemu exits. Generous timeout because
  // that flush can take seconds under host memory pressure, and waiting beats
  // orphaning a half-written snapshot.
  if (serial) {
    await runAdb(["-s", serial, "emu", "kill"], { timeoutMs: 15_000 }).catch(() => {});
  }
  if (!child) return;
  // Fallback for a wedged console (hypervisor stall, GPU driver reset, IO-thread
  // deadlock all leave qemu alive but deaf to `adb emu kill`). SIGTERM, not
  // SIGKILL: qemu's SIGTERM handler mirrors the console-kill flush, so a
  // snapshot stays consistent, while SIGKILL could truncate an in-flight ram.bin
  // write. Fire-and-forget — if SIGTERM is ignored too, qemu is unrecoverable.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// Termination path for an emulator spawned detached but never registered with
// adb: with no serial, `adb emu kill` has nothing to target. SIGTERM only and
// fire-and-forget — qemu's handler flushes like the console kill, SIGKILL could
// truncate a mid-write ram.bin, and a qemu that ignores SIGTERM is unrecoverable.
function killDetachedEmulator(child: import("node:child_process").ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Verify that `screencap` returns real pixel data, not a blank frame.
 *
 * Observed on hot-boot restore: every Android-side readiness probe passes
 * (`sys.boot_completed=1`, `pm path android`, focused launcher, SurfaceFlinger
 * display enabled, `gfxinfo` rendering) yet every pixel `screencap` returns is
 * zero, and the state is sticky — waking, dismissing keyguard, launching an
 * activity and capturing on-device all reproduce it, and only a cold boot
 * restores a working capture path. Suspected cause: SurfaceFlinger's host-side
 * composite buffer is not restored with the guest state. A caller that trusts
 * `booted:true` would silently get blank screenshots.
 *
 * Detection thresholds the PNG byte count (see `FRAME_PROBE`): a raw-RGBA
 * "any non-zero byte" check cannot work, because Android fills uninitialised
 * framebuffers with `(0,0,0,0xFF)`, so alpha is non-zero before anything is
 * drawn.
 *
 * Polls rather than probing once, because a restore can read blank for a while
 * before the composite hydrates. On `budgetMs` expiry the emulator is killed so
 * the caller falls through to a cold boot.
 */
async function assertScreencapAlive(
  serial: string,
  budgetMs: number = STAGE_BUDGET.firstRealFrameHot
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Success only on "1": empty output (no screencap binary, nothing captured)
  // must count as a failure, not as a healthy capture path.
  let lastReading: string | null = null;
  while (Date.now() < deadline) {
    try {
      const out = await adbShell(serial, FRAME_PROBE, { timeoutMs: 10_000 });
      lastReading = out.trim();
      if (lastReading === "1") return;
    } catch (err) {
      lastReading = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  await killEmulatorQuietly(serial);
  throw new FailureError(
    `hot-boot composite did not restore within ${budgetMs / 1000}s — \`screencap\` last returned ` +
      `${JSON.stringify(lastReading ?? "no probe response")}. Falling back to cold boot so screenshots are usable.`,
    {
      error_code: FAILURE_CODES.BOOT_ANDROID_HOT_BOOT_FRAME_UNUSABLE,
      failure_stage: "boot_android_hot_boot_frame",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

/**
 * Cold-boot counterpart to `assertScreencapAlive`.
 *
 * `sys.boot_completed=1` fires before SurfaceFlinger has composited the
 * lockscreen — under software rendering the gap runs to tens of seconds, so a
 * caller that trusts `booted:true` and screenshots gets an all-black PNG. The
 * blank is transient here, so poll `FRAME_PROBE` until a frame crosses the size
 * threshold. `KEYCODE_WAKEUP` is issued once in case the display went dim right
 * after boot.
 *
 * On deadline expiry we throw without killing the emulator: the device is
 * otherwise healthy and the caller's cold-boot catch adds the wipe-data hint.
 */
async function awaitFirstRealFrame(serial: string, timeoutMs: number): Promise<void> {
  await adbShell(serial, "input keyevent 224", { timeoutMs: 5_000 }).catch(() => {
    // KEYCODE_WAKEUP best-effort; absence of input service is non-fatal.
  });
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const out = await adbShell(serial, FRAME_PROBE, { timeoutMs: 10_000 });
      if (out.trim() === "1") return;
      lastError = `screencap reading was "${out.trim()}"`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new FailureError(
    `SurfaceFlinger did not composite a real frame within ${timeoutMs / 1000}s of boot_completed ` +
      `(${lastError ?? "no probe response"}). The emulator booted but every screenshot would be all-black.`,
    {
      error_code: FAILURE_CODES.BOOT_ANDROID_FIRST_FRAME_TIMEOUT,
      failure_stage: "boot_android_first_real_frame",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

async function findSerialByAvdName(avdName: string, deadline: number): Promise<string | null> {
  while (Date.now() < deadline) {
    const devices = await listAndroidDevices().catch(() => []);
    const match = devices.find((d) => d.isEmulator && d.avdName === avdName);
    if (match) return match.serial;
    await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVALS_MS.serialByAvd));
  }
  return null;
}

async function listNewEmulatorSerials(before: Set<string>): Promise<string[]> {
  // 3 s per poll — a hung adb daemon on the default 30 s timeout would eat
  // the whole outer stage budget in a single call.
  const { stdout } = await runAdb(["devices"], { timeoutMs: 3_000 }).catch(() => ({
    stdout: "",
    stderr: "",
  }));
  const lines = stdout.split("\n");
  const now: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(emulator-\d+)\s+/);
    if (m) now.push(m[1]!);
  }
  return now.filter((s) => !before.has(s));
}

async function bootIos(
  udid: string,
  registry: Registry,
  force?: boolean,
  headless?: boolean
): Promise<{ platform: "ios"; udid: string; booted: true } | NativeDevtoolsInitFailedResult> {
  // Catch the non-darwin case before `ensureDep("xcrun")` so a Linux user
  // gets "iOS requires macOS" rather than a misleading "install xcode-select".
  if (process.platform !== "darwin") {
    throw new FailureError(
      `iOS Simulator is unavailable on ${process.platform}: it requires a macOS host. ` +
        `Pass \`avdName\` (Android) instead of \`udid\` (iOS) to boot a device from this host.`,
      {
        error_code: FAILURE_CODES.BOOT_IOS_UNSUPPORTED_HOST,
        failure_stage: "boot_ios_host_platform",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  await ensureDep("xcrun");

  const simMatch = await listIosSimulators()
    .then((sims) => sims.find((s) => s.udid === udid))
    .catch(() => undefined);
  const simState = simMatch?.state;
  const isTvOs = simMatch?.runtimeKind === "tv";
  // listIosSimulators above already learned which device set owns this UDID,
  // so this resolves from cache; every simctl below targets that set.
  const deviceSet = await deviceSetForUdid(udid);
  const prefix = simctlPrefix(deviceSet);

  // force=true on a running sim: shut it down so we can pre-write AX prefs.
  if (force && simState === "Booted") {
    await execFileAsync("xcrun", [...prefix, "shutdown", udid]);
  }

  const needsPreBoot = simState === "Shutdown" || (force && simState === "Booted");
  if (needsPreBoot) {
    await setAccessibilityPrefsPreBoot(udid).catch((err: unknown) => {
      process.stderr.write(
        `[boot-device ${udid.slice(0, 8)}] pre-boot AX pref write failed (${
          err instanceof Error ? err.message : String(err)
        }); ensureAutomationEnabled will write prefs post-boot but SB won't pick them up until next restart.\n`
      );
    });
  }

  await execFileAsync("xcrun", [...prefix, "boot", udid]).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Unable to boot device in current state: Booted")) {
      throw err;
    }
  });
  await execFileAsync("xcrun", [...prefix, "bootstatus", udid, "-b"]);

  // tvOS only: a boot transition orphans the host-side tvos-hid-daemon, which
  // holds a SimDeviceLegacyClient bound to the previous boot for its whole
  // lifetime (unlike the ax daemon, which runs inside the sim and is respawned).
  // The daemon survives the reboot with an invalid client and its sends are
  // fire-and-forget, so TV button presses silently no-op. Dropping the cached
  // TvControl service forces the next TV call to rebuild it against the new
  // boot. ServiceNotFoundError just means nothing was cached.
  if (isTvOs && needsPreBoot) {
    await registry.disposeService(`${TV_CONTROL_NAMESPACE}:${udid}`).catch((err: unknown) => {
      if (err instanceof ServiceNotFoundError) return;
      process.stderr.write(
        `[boot-device ${udid.slice(0, 8)}] failed to recycle stale TvControl service after reboot (${
          err instanceof Error ? err.message : String(err)
        }); TV button presses may no-op until the tool-server restarts.\n`
      );
    });

    // The same boot transition wipes the sim's launchd DYLD_INSERT_LIBRARIES,
    // but a cached NativeDevtools keeps a sticky envSetup=true from the previous
    // boot, so ensureEnvReady() short-circuits and never re-sets it. Dropping the
    // service forces a rebuild with envSetup=false. tvOS-gated to match the
    // validated repro; widen if this is ever reproduced on iOS.
    const ndUrn = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" }).urn;
    await registry.disposeService(ndUrn).catch((err: unknown) => {
      if (err instanceof ServiceNotFoundError) return;
      process.stderr.write(
        `[boot-device ${udid.slice(0, 8)}] failed to recycle stale NativeDevtools service after reboot (${
          err instanceof Error ? err.message : String(err)
        }); native-devtools may stay disconnected until the tool-server restarts.\n`
      );
    });
  }

  // Covers the sim that was already Booted without force, where no pre-boot
  // write happened: SB won't pick these prefs up until the next restart, but
  // describe surfaces a degraded-quality hint.
  await ensureAutomationEnabled(udid).catch(() => undefined);

  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  const ndApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  // The (re)boot wiped DYLD_INSERT_LIBRARIES from launchd. A service cached from
  // before the boot has its one-shot env latch set, so `ensureEnvReady` would
  // skip re-applying and the next launch would be uninjected. Failures surface
  // via getInitFailure below.
  await ndApi.reverifyEnv().catch(() => {});
  const initFailure = ndApi.getInitFailure();
  if (initFailure?.givenUp) {
    return buildInitFailedResult(udid, initFailure);
  }
  // A Simulator.app instance displays ONE device set (the default, unless
  // launched with -DeviceSetPath), so a device from an additional set can only
  // run headless and stream via simulator-server. Skip the GUI attach and the
  // CurrentDeviceUDID write, which only steers the default-set window.
  if (!deviceSet) {
    await execFileAsync("defaults", [
      "write",
      "com.apple.iphonesimulator",
      "CurrentDeviceUDID",
      udid,
    ]).catch(() => {});
  }
  // `simctl boot` above already booted the device core headless; opening
  // Simulator.app only attaches the GUI window, which surfaces streaming through
  // simulator-server don't need. ARGENT_SIMULATOR_NO_WINDOW forces the same skip
  // host-wide.
  if (!headless && !iosHeadlessFromEnv() && !deviceSet) {
    // Xcode 27 replaces Simulator.app with Device Hub.app (com.apple.dt.Devices);
    // the attach stays best-effort so a missing app never fails a boot whose core
    // is already up.
    await execFileAsync("open", ["-a", "Simulator.app"])
      .catch(() => execFileAsync("open", ["-b", "com.apple.dt.Devices"]))
      .catch(() => {});
  }
  return { platform: "ios", udid, booted: true };
}

/**
 * Boot a remote iOS simulator through `sim-remote`. Mirrors `bootIos` but:
 *
 * - Uses `sim-remote simctl` for boot/shutdown/bootstatus (no local xcrun).
 * - Pre-warms the native-devtools blueprint so the dylib injection env is set
 *   inside the remote sim before the app launches. Accessibility defaults are
 *   applied lazily by the ax-service blueprint's `bootstrapAx` over the
 *   orchestrator's generic spawn — we have no filesystem access to the remote
 *   sim, so there is no pre-boot plist write.
 */
async function bootIosRemote(
  id: string,
  registry: Registry,
  force?: boolean
): Promise<
  { platform: "ios-remote"; udid: string; booted: true } | NativeDevtoolsInitFailedResult
> {
  await ensureDep("sim-remote");
  const udid = stripRemotePrefix(id);

  // Lookup failures are treated as unknown state: the boot/bootstatus dance
  // below tolerates an already-booted sim.
  let simState: string | undefined;
  try {
    const list = await simRemoteListDevices();
    outer: for (const devices of Object.values(list.devices)) {
      for (const d of devices) {
        if (d.udid === udid) {
          simState = d.state;
          break outer;
        }
      }
    }
  } catch {
    simState = undefined;
  }

  if (force && simState === "Booted") {
    await simRemoteShutdown(id).catch(() => undefined);
  }

  // A `Booted` error from sim-remote just means it is already up; bootstatus
  // below normalizes the state either way.
  await simRemoteBoot(id).catch((err: Error) => {
    if (!/Booted/i.test(err.message)) throw err;
  });
  await simRemoteBootstatus(id, { boot: true });

  const ndRef = nativeDevtoolsRef({ id, platform: "ios-remote", kind: "simulator" });
  const ndApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  const initFailure = ndApi.getInitFailure();
  if (initFailure?.givenUp) {
    return buildInitFailedResult(id, initFailure);
  }

  return { platform: "ios-remote", udid: id, booted: true };
}

// Bounds the pathological hot boot where the snapshot loads but the guest's
// system_server is stuck; without the cap that hang would eat the cold-boot
// budget before we retry.
const HOT_BOOT_BUDGET_MS = 90_000;

/**
 * One boot attempt with the supplied emulator args, shared by the hot-boot path
 * and the cold-boot fallback. The caller supplies `serialsBefore` (captured once
 * per `bootAndroid` invocation, before either attempt) because recomputing it
 * between attempts could include a failed hot-boot child still being reaped.
 */
async function attemptBoot(params: {
  avdName: string;
  emulatorBinary: string;
  emulatorArgs: string[];
  attemptDeadline: number;
  serialsBefore: Set<string>;
  adbRegisterBudgetMs: number;
  deviceReadyBudgetMs: number;
  bootCompletedBudgetMs: number;
  // How long to keep retrying the PackageManager sanity probe before giving up.
  pmProbeBudgetMs: number;
  // Tear the emulator down and throw when the PM probe never succeeds. True on
  // the hot-boot attempt (the caller can still fall back to a cold boot); false
  // on the final cold attempt, where a slow-but-alive guest is returned as
  // booted rather than destroyed.
  tearDownIfUnready: boolean;
}): Promise<{ serial: string }> {
  // On Windows the emulator hangs mid-boot when spawned with stdio:"ignore" —
  // a detached process whose stdout/stderr are NUL never reaches
  // sys.boot_completed — so give it a per-AVD log file for valid write handles.
  // The name is fixed per AVD and truncated on open, so boots reuse one file
  // rather than littering temp; only one emulator per AVD can run at a time, so
  // there is no concurrent writer. POSIX keeps "ignore".
  let emulatorLogFd: number | undefined;
  let stdio: StdioOptions = "ignore";
  if (process.platform === "win32") {
    const safeName = params.avdName.replace(/[^\w.-]/g, "_");
    const logPath = join(tmpdir(), `argent-emulator-${safeName}.log`);
    emulatorLogFd = openSync(logPath, "w");
    stdio = ["ignore", emulatorLogFd, emulatorLogFd];
  }
  const child = spawn(params.emulatorBinary, params.emulatorArgs, {
    detached: true,
    stdio,
  });
  child.unref();
  // The child holds its own handle for the log fd; close the parent's copy so a
  // descriptor doesn't leak per boot.
  if (emulatorLogFd !== undefined) {
    try {
      closeSync(emulatorLogFd);
    } catch {
      // best-effort — the child keeps its own handle regardless
    }
  }

  let earlyExitError: Error | null = null;
  child.on("exit", (code, signal) => {
    // A QEMU SIGSEGV/SIGABRT arrives as `code === null, signal !== null`, so a
    // signal must be treated as an early exit or the outer wait hangs until the
    // stage budget elapses.
    if (signal) {
      earlyExitError = new Error(
        `emulator binary terminated by signal ${signal} before the device booted. ` +
          `Common causes: ram.bin corruption on hot-boot restore, hypervisor crash, host OOM. ` +
          `Try \`emulator -avd ${params.avdName} -verbose\` from a terminal to see the exact error.`
      );
      return;
    }
    if (code !== 0 && code !== null) {
      earlyExitError = new Error(
        `emulator binary exited with code ${code} before the device booted. ` +
          `Common causes: AVD corrupted, Hypervisor unavailable, or disk full. ` +
          `Try \`emulator -avd ${params.avdName} -verbose\` from a terminal to see the exact error.`
      );
    }
  });
  // `spawn` failures (ENOENT, EACCES) arrive as an `error` event; unhandled,
  // that escapes as an uncaught exception and crashes the tool-server. Funnel it
  // into the same earlyExitError race so the boot promise rejects with the real
  // cause and the in-flight Map entry is cleared.
  child.on("error", (err: NodeJS.ErrnoException) => {
    earlyExitError = new Error(
      `Failed to spawn emulator binary (${err.code ?? "unknown"}): ${err.message}. ` +
        `Verify Android SDK Emulator is installed and on PATH, then retry.`
    );
  });
  // `earlyExitError` is assigned only inside the handler closures above, so a
  // direct read flow-narrows to `null`. This getter preserves the declared
  // `Error | null` type.
  const readEarlyExitError = (): Error | null => earlyExitError;

  // Stage 2: wait for adb to see the new emulator.
  let serial: string | null = null;
  const adbDeadline = Math.min(params.attemptDeadline, Date.now() + params.adbRegisterBudgetMs);
  try {
    while (Date.now() < adbDeadline) {
      const launchError = readEarlyExitError();
      if (launchError) throw launchError;
      const newSerials = await listNewEmulatorSerials(params.serialsBefore);
      if (newSerials.length >= 1) {
        if (newSerials.length === 1) {
          serial = newSerials[0]!;
          break;
        }
        const byAvd = await findSerialByAvdName(params.avdName, Date.now() + 3_000);
        if (byAvd) {
          serial = byAvd;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVALS_MS.adbRegister));
    }
  } catch (err) {
    killDetachedEmulator(child);
    throw err;
  }
  if (!serial) {
    const launchError = readEarlyExitError();
    if (launchError) {
      killDetachedEmulator(child);
      throw launchError;
    }
    killDetachedEmulator(child);
    throw new FailureError(
      `Emulator "${params.avdName}" did not register within ${params.adbRegisterBudgetMs / 1000}s. ` +
        `The emulator process has been terminated.`,
      {
        error_code: FAILURE_CODES.BOOT_ANDROID_ADB_REGISTER_TIMEOUT,
        failure_stage: "boot_android_adb_register",
        failure_area: "tool_server",
        error_kind: "timeout",
      }
    );
  }

  const stage3Racer = createEarlyExitRacer(() => earlyExitError);
  try {
    await Promise.race([
      runAdb(["-s", serial, "wait-for-device"], {
        timeoutMs: Math.min(
          params.deviceReadyBudgetMs,
          Math.max(1_000, params.attemptDeadline - Date.now())
        ),
      }),
      stage3Racer.promise,
    ]);
  } catch (err) {
    await killEmulatorQuietly(serial, child);
    throw err instanceof Error
      ? err
      : new Error(`adb wait-for-device failed for ${serial}: ${String(err)}.`);
  } finally {
    stage3Racer.cancel();
  }

  const bootBudget = Math.max(
    5_000,
    Math.min(params.bootCompletedBudgetMs, params.attemptDeadline - Date.now())
  );
  try {
    await waitForBootCompleted(serial, bootBudget, { shouldAbort: () => earlyExitError });
  } catch (err) {
    await killEmulatorQuietly(serial, child);
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Stage 5: PackageManager sanity — a snapshot restore preserves
  // sys.boot_completed=1, so this is the first real proof the guest is live.
  // `pm` can take tens of seconds on a loaded host or a freshly wiped image
  // still scanning packages, so retry within a budget instead of failing on one
  // window. Each attempt races earlyExitError so a real crash surfaces as the
  // signal/exit-code error instead of "PackageManager did not respond".
  const pmBudgetMs = Math.max(10_000, params.pmProbeBudgetMs);
  const pmDeadline = Math.min(params.attemptDeadline, Date.now() + pmBudgetMs);
  let pmReady = false;
  let pmCrash: Error | null = null;
  while (Date.now() < pmDeadline && !earlyExitError) {
    const stage5Racer = createEarlyExitRacer(() => earlyExitError);
    try {
      await Promise.race([
        adbShell(serial, "pm path android", {
          timeoutMs: Math.max(2_000, Math.min(10_000, pmDeadline - Date.now())),
        }),
        stage5Racer.promise,
      ]);
      pmReady = true;
      break;
    } catch (err) {
      // A QEMU crash mid-probe is terminal — stop retrying and surface it below.
      if (err instanceof Error && /^emulator binary (exited|terminated)/.test(err.message)) {
        pmCrash = err;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      stage5Racer.cancel();
    }
  }

  if (!pmReady) {
    // A confirmed crash always tears down and rethrows the real cause.
    const crash = pmCrash ?? earlyExitError;
    if (crash) {
      await killEmulatorQuietly(serial, child);
      throw crash;
    }
    // Tear down only while a fallback remains (hot -> cold). On the final
    // attempt a guest that reached boot_completed is still usable — gRPC
    // screenshots/gestures work without PM — and killing it guarantees failure.
    if (params.tearDownIfUnready) {
      await killEmulatorQuietly(serial, child);
      throw new FailureError(
        `PackageManager did not respond on ${serial} within ${Math.round(pmBudgetMs / 1000)}s ` +
          `after boot_completed. Emulator has been terminated.`,
        {
          error_code: FAILURE_CODES.BOOT_ANDROID_PACKAGE_MANAGER_UNAVAILABLE,
          failure_stage: "boot_android_package_manager",
          failure_area: "tool_server",
          error_kind: "timeout",
        }
      );
    }
    process.stderr.write(
      `[boot-device] ${serial} reached boot_completed and registered with adb, but PackageManager ` +
        `stayed slow for ${Math.round(pmBudgetMs / 1000)}s; returning it as booted rather than ` +
        `tearing it down. Give it a few seconds to settle if taps or screenshots misbehave.\n`
    );
  }

  return { serial };
}

// In-flight boot per AVD. Two concurrent `bootAndroid` calls for the same AVD
// would both pass the "already running" fast path (the emulator hasn't
// registered yet) and spawn QEMU twice; the second collides on the AVD's
// exclusive on-disk lock and bails with a confusing "Running multiple
// emulators". Coalescing makes the duplicate reuse the first result or error.
const inFlightBoots = new Map<
  string,
  Promise<{
    platform: "android";
    serial: string;
    avdName: string;
    booted: true;
  }>
>();

/**
 * Clear the in-flight boot map. For tests that intentionally abandon a
 * half-started boot: the leaked promise would otherwise coalesce into the next
 * test targeting the same AVD and starve it of a real spawn.
 */
export function __resetInFlightBootsForTesting(): void {
  inFlightBoots.clear();
}

async function bootAndroid(params: {
  avdName: string;
  bootTimeoutMs: number;
  force?: boolean;
  sound: boolean;
}): Promise<{
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
}> {
  const existing = inFlightBoots.get(params.avdName);
  if (existing) return existing;
  const promise = bootAndroidImpl(params).finally(() => {
    inFlightBoots.delete(params.avdName);
  });
  inFlightBoots.set(params.avdName, promise);
  return promise;
}

async function bootAndroidImpl(params: {
  avdName: string;
  bootTimeoutMs: number;
  force?: boolean;
  sound: boolean;
}): Promise<{
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
}> {
  // Preflight both Android binaries up front so a missing emulator package
  // surfaces as an install hint, not a misleading "no AVDs" from `listAvds()`.
  // `ensureDep` resolves through `$ANDROID_HOME` as well as PATH.
  await ensureDep("adb");
  await ensureDep("emulator");
  // Validate boot-configuration env vars before any slow I/O so a typo in
  // ARGENT_EMULATOR_GPU_MODE surfaces immediately rather than mid-boot with a
  // misleading "emulator has been terminated" suffix.
  const gpuMode = selectGpuMode();
  // Opt-in headless mode via ARGENT_EMULATOR_NO_WINDOW (see no-window-env.ts).
  const extraEmulatorArgs = androidHeadlessFromEnv() ? ["-no-window"] : [];
  const hardeningArgs = launchHardeningArgs(params.sound);

  for (const msg of linuxBootDiagnostics(params.avdName) ?? []) {
    console.warn(`[boot-device:linux] ${msg}`);
  }
  const emulatorBinary = await resolveEmulatorOrThrow();
  const overallDeadline = Date.now() + params.bootTimeoutMs;

  // Stage 0: validate the AVD exists. The preflight ruled out a missing binary,
  // so an empty list here really means the user has no AVDs.
  const avds = await listAvds();
  if (avds.length === 0) {
    throw new FailureError(
      "`emulator -list-avds` returned no AVDs. Create one via Android Studio or `avdmanager create avd`.",
      {
        error_code: FAILURE_CODES.BOOT_ANDROID_NO_AVDS,
        failure_stage: "boot_android_avd_list",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  if (!avds.some((a) => a.name === params.avdName)) {
    throw new FailureError(
      `AVD "${params.avdName}" not found. Available: ${avds.map((a) => a.name).join(", ")}.`,
      {
        error_code: FAILURE_CODES.BOOT_ANDROID_AVD_NOT_FOUND,
        failure_stage: "boot_android_avd_lookup",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  // Stage 0b: verify adb is on PATH *before* spawning the emulator, so we
  // don't orphan a detached emulator process just to later throw "adb missing".
  try {
    await runAdb(["version"], { timeoutMs: 5_000 });
  } catch (err) {
    throw new FailureError(
      `\`adb\` is not available on PATH (${
        err instanceof Error ? err.message : String(err)
      }). Install Android SDK Platform Tools before booting an emulator.`,
      {
        error_code: FAILURE_CODES.BOOT_ANDROID_ADB_UNAVAILABLE,
        failure_stage: "boot_android_adb_version",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "adb",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }

  // Start the adb daemon BEFORE snapshotting the serial list: with the daemon
  // down `adb devices` returns [], every already-connected emulator later looks
  // "new", and the tool could hand back an unrelated emulator as "booted".
  await runAdb(["start-server"], { timeoutMs: 10_000 }).catch(() => {});
  const existingDevices = await listAndroidDevices().catch(() => []);

  // Fast path: reuse this AVD when it is already running and ready, instead of
  // spawning a second emulator that collides on AVD locks and fails with a
  // misleading "Running multiple emulators" error.
  let hotBootFailureReason: string | null;
  const alreadyRunning = existingDevices.find(
    (d) => d.isEmulator && d.avdName === params.avdName && d.state === "device"
  );
  if (alreadyRunning) {
    if (params.force) {
      await killEmulatorQuietly(alreadyRunning.serial);
      const refreshed = await listAndroidDevices().catch(() => existingDevices);
      existingDevices.splice(0, existingDevices.length, ...refreshed);
    } else {
      // A long-running emulator can drift into the same sticky-blank
      // SurfaceFlinger state `assertScreencapAlive` guards against on hot boot:
      // readiness probes pass but every screenshot is black, and the fast path
      // would keep handing back that wedged serial. On failure the helper kills
      // the emulator and we fall through to the boot pipeline below.
      try {
        await assertScreencapAlive(alreadyRunning.serial);
        return {
          platform: "android",
          serial: alreadyRunning.serial,
          avdName: params.avdName,
          booted: true,
        };
      } catch (_err) {
        // assertScreencapAlive already killed the emulator; refresh the snapshot
        // so the killed serial is in serialsBefore and the upcoming spawn's
        // "new serial" diff stays correct.
        const refreshed = await listAndroidDevices().catch(() => existingDevices);
        existingDevices.splice(0, existingDevices.length, ...refreshed);
      }
    }
  }
  const serialsBefore = new Set(existingDevices.map((d) => d.serial));

  // Suppress the emulator's crash-report prompt/uploader on builds that accept
  // the flag: without it an emulator crash pops a Qt consent dialog that blocks
  // the next boot until a human dismisses it. Crash dumps are still written to
  // /tmp/android-unknown/emu-crash-*.db, so only the modal popup is lost.
  //
  // `-crash-report-mode` is undocumented and absent from many emulator builds
  // (36.1.9.0 does not list it in `-help`), so feature-detect it via `-help`
  // rather than pass it blind: an unrecognized flag aborts the launch before
  // boot with "unknown option: -crash-report-mode" and the device never comes
  // up. Computed here (after the already-running reuse fast-path returns) so
  // the `-help` probe is skipped when we are not going to spawn, and shared by
  // the snapshot probe and the hot- and cold-boot arg lists below. Unlike
  // hardeningArgs this one carries no snapshot risk — it selects crash
  // reporting, not qemu devices — but one decision reused across all three
  // spawns is a flag that cannot be detected differently for each.
  const crashReportArgs = (await emulatorSupportsFlag("-crash-report-mode"))
    ? ["-crash-report-mode", "never"]
    : [];

  // Hot boot only when a default_boot snapshot exists AND the emulator's own
  // `-check-snapshot-loadable` probe accepts it; the probe catches renderer/GPU
  // config drift and `snapshot.pb` corruption. Any failure falls back to cold
  // boot below.
  const hasSnapshot = await hasDefaultBootSnapshot(params.avdName);
  if (!hasSnapshot) {
    hotBootFailureReason = "no default_boot snapshot exists";
  } else {
    // Probe and boot must share the same renderer-affecting argv, or the probe
    // resolves a different renderer and rejects every valid snapshot with
    // "different renderer configured".
    const RENDERER_ARGS = ["-gpu", gpuMode, ...extraEmulatorArgs];
    const probe = await checkSnapshotLoadable(params.avdName, "default_boot", {
      extraArgs: [...RENDERER_ARGS, ...hardeningArgs, ...crashReportArgs],
    });
    if (!probe.loadable) {
      hotBootFailureReason = `-check-snapshot-loadable: ${probe.reason ?? "unknown"}`;
    } else {
      // `-force-snapshot-load` turns the emulator's silent fallback to cold boot
      // into a loud early exit, so ram.bin corruption the probe misses surfaces
      // in seconds. `-no-snapshot-save` keeps a force-kill on a failure path from
      // overwriting a working snapshot.
      const hotArgs = [
        "-avd",
        params.avdName,
        "-force-snapshot-load",
        "-no-snapshot-save",
        ...RENDERER_ARGS,
        ...hardeningArgs,
        ...crashReportArgs,
      ];
      const hotAttemptDeadline = Math.min(overallDeadline, Date.now() + HOT_BOOT_BUDGET_MS);
      try {
        const result = await attemptBoot({
          avdName: params.avdName,
          emulatorBinary,
          emulatorArgs: hotArgs,
          attemptDeadline: hotAttemptDeadline,
          serialsBefore,
          // Snapshot restores register with adb within seconds; a minute-long
          // wait here would mask a failed load that silently cold-boots.
          adbRegisterBudgetMs: 30_000,
          deviceReadyBudgetMs: 30_000,
          bootCompletedBudgetMs: 30_000,
          // Keep the hot path tight: one ~10 s PM window, tear down on failure so
          // we fall through to the cold boot below.
          pmProbeBudgetMs: 10_000,
          tearDownIfUnready: true,
        });
        await assertScreencapAlive(result.serial);
        return {
          platform: "android",
          serial: result.serial,
          avdName: params.avdName,
          booted: true,
        };
      } catch (err) {
        hotBootFailureReason = err instanceof Error ? err.message : String(err);
        // attemptBoot already killed the failed child. Refresh the before-set so
        // the cold-boot attempt doesn't mistake a zombie serial still listed by
        // `adb devices` for a new one.
        const refreshed = new Set(
          (await listAndroidDevices().catch(() => [])).map((d) => d.serial)
        );
        for (const s of refreshed) serialsBefore.add(s);
      }
    }
  }

  // Cold boot fallback (either no usable snapshot, or hot-boot attempt failed).
  // Renderer args mirror the hot-boot path so the snapshot this cold boot
  // saves matches the renderer the next launch's probe will resolve.
  // hardeningArgs likewise — `-noaudio` and `-netfast` change device topology,
  // so a mismatch between cold-save and hot-load would invalidate the saved
  // snapshot. crashReportArgs rides along from the same detection.
  const coldArgs = [
    "-avd",
    params.avdName,
    "-no-snapshot-load",
    "-gpu",
    gpuMode,
    ...extraEmulatorArgs,
    ...hardeningArgs,
    ...crashReportArgs,
  ];
  let coldResult: { serial: string };
  try {
    coldResult = await attemptBoot({
      avdName: params.avdName,
      emulatorBinary,
      emulatorArgs: coldArgs,
      attemptDeadline: overallDeadline,
      serialsBefore,
      adbRegisterBudgetMs: STAGE_BUDGET.adbRegister,
      deviceReadyBudgetMs: STAGE_BUDGET.deviceReady,
      bootCompletedBudgetMs: STAGE_BUDGET.bootCompleted,
      // Final attempt: retry PM for longer and don't tear the emulator down if
      // it stays slow — a guest that reached boot_completed is usable, and there
      // is no further fallback to justify destroying it.
      pmProbeBudgetMs: STAGE_BUDGET.pmReady,
      tearDownIfUnready: false,
    });
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const suffix = hotBootFailureReason
      ? ` Hot-boot was not viable (${hotBootFailureReason}).`
      : "";
    throw new FailureError(
      `${base} Emulator has been terminated so the next boot starts clean.` +
        ` If this keeps happening, wipe the AVD with \`emulator -avd ${params.avdName} -wipe-data\`.${suffix}`,
      {
        error_code: FAILURE_CODES.BOOT_ANDROID_COLD_BOOT_FAILED,
        failure_stage: "boot_android_cold_boot",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }

  // Cold-boot post-condition: the lockscreen composite lags boot_completed, so
  // without this a boot-device → screenshot chain gets a silent all-black PNG
  // (see `awaitFirstRealFrame`). Clamped to the remaining overall deadline so
  // this stage can't push past bootTimeoutMs; kill on timeout so the emulator
  // doesn't linger until the next boot-device call.
  const frameWaitBudget = Math.min(
    STAGE_BUDGET.firstRealFrame,
    Math.max(0, overallDeadline - Date.now())
  );
  try {
    await awaitFirstRealFrame(coldResult.serial, frameWaitBudget);
  } catch (err) {
    await killEmulatorQuietly(coldResult.serial);
    throw err;
  }

  return {
    platform: "android",
    serial: coldResult.serial,
    avdName: params.avdName,
    booted: true,
  };
}

/**
 * Poll an exit-state getter and reject as soon as it returns non-null. Raced
 * against blocking adb calls so a detached-emulator crash surfaces as its own
 * error instead of a generic adb timeout.
 *
 * The caller must call `cancel()` in a `finally` once the race resolves, or the
 * recursive `setTimeout` chain keeps firing for the life of the process.
 */
function createEarlyExitRacer(getExit: () => Error | null): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    const tick = () => {
      if (cancelled) return;
      const err = getExit();
      if (err) {
        reject(err);
        return;
      }
      timer = setTimeout(tick, BOOT_POLL_INTERVALS_MS.earlyExit);
    };
    timer = setTimeout(tick, BOOT_POLL_INTERVALS_MS.earlyExit);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// boot-device dispatches internally on `udid` vs `avdName` vs `electronAppPath`
// rather than via `dispatchByPlatform`, which assumes a single udid input. The
// capability is still declared so the HTTP gate rejects e.g. an iOS udid on a
// host without xcrun.
type VegaBootResult = { platform: "vega"; serial: string; vvdImage: string; booted: true };

// Coalesce concurrent Vega boots (mirrors `inFlightBoots` for Android): two
// callers must not both shell out `vega virtual-device start` for the same image.
const inFlightVegaBoots = new Map<string, Promise<VegaBootResult>>();

async function bootVegaImpl(params: {
  vvdImage: string;
  bootTimeoutMs: number;
  force?: boolean;
}): Promise<VegaBootResult> {
  await ensureDep("vega");

  const images = await listVvdImages();
  const image = images.find((i) => i.name === params.vvdImage);
  if (!image) {
    const available = images.map((i) => i.name).join(", ") || "(none found)";
    throw new FailureError(
      `Vega VVD image "${params.vvdImage}" not found. Available: ${available}. ` +
        "Image names come from `list-devices` → the `vvdImage` field on a Vega device.",
      {
        error_code: FAILURE_CODES.VEGA_IMAGE_NOT_FOUND,
        failure_stage: "boot_vega_image_lookup",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  const running = await isVvdRunning();
  if (running && !params.force) {
    // Already up. v1 supports a single running VVD and can't boot a second, so
    // resolve the image that is actually running and label the payload with it
    // rather than assuming the request was honored.
    const current = await listVegaDevices();
    const runningVvd = current.find((d) => d.kind === "vvd" && d.state === "running" && d.serial);
    const runningImage = runningVvd?.vvdImage ?? null;
    // Only report already-satisfied on a POSITIVE match. An unconfirmable running
    // image (`null` — an unresolved profile with 2+ installed images, or 2+
    // running VVDs) counts as a mismatch: otherwise we'd return booted:true while
    // a different VVD is the one every later tool drives.
    if (runningImage !== params.vvdImage) {
      const which = runningImage ? `("${runningImage}")` : "(its image could not be confirmed)";
      throw new FailureError(
        `A Vega VVD ${which} is already running; argent v1 supports a single running VVD. ` +
          `To boot "${params.vvdImage}", re-run boot-device with force:true, which stops the ` +
          "current VVD first (by process, since the `vega` CLI does not reliably stop a VVD " +
          "argent booted) and then boots the requested image.",
        {
          error_code: FAILURE_CODES.VEGA_ALREADY_RUNNING,
          failure_stage: "boot_vega_already_running",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }
    return {
      platform: "vega",
      serial: runningVvd?.serial ?? (await resolveRunningVvdSerial()),
      vvdImage: runningImage, // == params.vvdImage (positively confirmed above)
      booted: true,
    };
  }
  if (running && params.force) {
    await stopVvd();
  }

  // One shared budget across both stages: startVvd consumes part of
  // bootTimeoutMs, so waitForVvdRunning gets only what remains — otherwise the
  // worst case before a boot failure surfaces is ~2x the requested deadline.
  const bootDeadline = Date.now() + params.bootTimeoutMs;
  await startVvd({
    timeoutSeconds: Math.ceil(params.bootTimeoutMs / 1_000),
    imagePath: image.path,
  });
  await waitForVvdRunning(Math.max(0, bootDeadline - Date.now()));

  return {
    platform: "vega",
    serial: await resolveRunningVvdSerial(),
    vvdImage: params.vvdImage,
    booted: true,
  };
}

function bootVega(params: {
  vvdImage: string;
  bootTimeoutMs: number;
  force?: boolean;
}): Promise<VegaBootResult> {
  // Key the coalescing on `force` too: a force boot does a stop+start restart, so
  // it must not join an in-flight non-force boot that would skip the restart and
  // hand back the stale device.
  const key = `${params.vvdImage}${params.force ? "force" : "normal"}`;
  const existing = inFlightVegaBoots.get(key);
  if (existing) return existing;
  const promise = bootVegaImpl(params).finally(() => {
    inFlightVegaBoots.delete(key);
  });
  inFlightVegaBoots.set(key, promise);
  return promise;
}

/**
 * `udid` is the id to drive next: the connect-key id once the instance reached
 * `hdc`, the instance id when it did not. Only the first is an id the
 * interaction tools accept.
 *
 * `note` does not mark which of the two it is. It carries whatever the boot
 * left unproven — why no key was resolved, or what is unestablished about the
 * one that was — so a caller reading it as "this is the instance id" is wrong
 * exactly when the caveat matters.
 */
type HarmonyBootResult = {
  platform: "harmony";
  udid: string;
  instanceName: string;
  booted: true;
  note?: string;
};

// Coalesce concurrent HarmonyOS boots (mirrors `inFlightVegaBoots`): two callers
// must not both shell out `Emulator -start` for the same instance. The flag
// travels beside the promise so a boot with the other `force` value can tell
// sharing from serialization.
const inFlightHarmonyBoots = new Map<
  string,
  { force: boolean; promise: Promise<HarmonyBootResult> }
>();

/**
 * Sized for a `force` restart, which spends one budget on a shutdown and a boot.
 * The start reaches a connected target in 8-20s; the shutdown is the
 * unpredictable half, since `-stop` returns as soon as it has asked and the
 * instance then took anywhere from 9s to ~70s to actually go down across
 * measured runs — and once had not gone down three minutes later.
 */
const HARMONY_BOOT_TIMEOUT_MS = 180_000;

/**
 * Each poll spawns `hdc` and round-trips its daemon, an order of magnitude
 * dearer than the adb polls in {@link BOOT_POLL_INTERVALS_MS} — and a boot this
 * waits on is minutes long.
 */
const HARMONY_TARGET_POLL_MS = 2_000;

/**
 * How long the manager is watched for an immediate failure when there is no
 * `hdc` to wait on a target with. A failing `-start` prints its diagnostic and
 * exits at once, so this only has to outlast process startup — it is not a boot
 * budget, and the connector-absent path must still fail fast.
 */
const HARMONY_NO_HDC_GRACE_MS = 3_000;

/** How long a spent start-attempt log may keep occupying tmpdir before a sweep. */
const HARMONY_LOG_TTL_MS = 24 * 60 * 60 * 1_000;

/** Cadence for the grace above; short, since it is only outlasting a process start. */
const HARMONY_EXIT_POLL_MS = 50;

/**
 * `Emulator -install` outside mainland China prints "…available only in the
 * Chinese mainland" and downloads nothing, and no instance can be created
 * without an image. The manager only ever reports the symptom of that — a
 * missing instance, or a missing image — so name the cause ourselves.
 */
const HARMONY_IMAGE_RESTRICTION =
  "Huawei serves HarmonyOS emulator images only within mainland China; outside it no image can " +
  "be downloaded, so no instance can be created and none can be started. argent cannot supply " +
  "the image; an instance has to be created in DevEco Studio on a host that can download one.";

/**
 * Said when the start failed and the listing came back empty. Empty is what a
 * host that simply has not created an instance yet looks like — including
 * inside mainland China, where the download works — and equally what a `-list`
 * that ran and printed a diagnostic looks like, since `listHarmonyInstances`
 * answers `[]` for that too. So this states what was observed and offers the
 * restriction as a possible cause rather than asserting it the way
 * {@link HARMONY_IMAGE_RESTRICTION} does.
 */
const HARMONY_NO_INSTANCES =
  "The emulator manager listed no HarmonyOS instances — either none has been created, or the " +
  "listing itself failed; `Emulator -list -details` shows which. Create one in DevEco Studio if " +
  "there is none. If creating one fails for want of an image, note that Huawei serves HarmonyOS " +
  "emulator images only within mainland China.";

/** Said when the instance was already running, its target therefore unidentifiable. */
const HARMONY_ALREADY_RUNNING =
  "The instance was already running, so argent did not restart it — and an instance argent did " +
  "not start cannot be matched to the `hdc` connect key it registered under. Take the connect " +
  'key from `list-devices` (the `kind: "device"` entry), or re-run with `force: true` to ' +
  "restart the instance and have its key resolved here.";

/**
 * Said when the instance started but never reached `hdc` in time. Not a
 * failure — the manager did start it, and a cold boot can outlast a budget the
 * caller chose.
 */
const HARMONY_NO_TARGET =
  "The instance started but had not registered with `hdc` before the boot budget ran out, so " +
  "this payload names the instance rather than a connect key. Give it longer with " +
  "`bootTimeoutMs`, or call `list-devices` once it finishes booting and drive the `kind: " +
  '"device"` entry that appears.';

/**
 * Said when more than one eligible target registered inside the boot window, so
 * arrival cannot pick the instance out. Distinct from {@link HARMONY_NO_TARGET}:
 * the budget is not the problem — both targets DID register — and pointing the
 * caller at `bootTimeoutMs` would misdiagnose a refusal to guess.
 */
const HARMONY_AMBIGUOUS_TARGET =
  "More than one `hdc` target registered while the instance was booting, so argent could not " +
  "tell which is the instance it started and did not guess. Call `list-devices` and drive the " +
  '`kind: "device"` entry for the instance, or stop the other emulator and re-run.';

/**
 * Said when every target that registered answered with some other device's
 * panel. Distinct from {@link HARMONY_NO_TARGET} in the same way
 * {@link HARMONY_AMBIGUOUS_TARGET} is: something did register, so a longer
 * budget cannot help, and the caller needs to know a target was seen and
 * declined rather than that none appeared.
 */
const HARMONY_MISMATCHED_TARGET =
  "A target registered while the instance was booting, but its display is not the panel this " +
  "instance is configured with, so it is another device rather than the one argent started. " +
  'Call `list-devices` and drive the `kind: "device"` entry for the instance once it appears.';

/**
 * Said when a target registered but never reported a panel to check it against.
 * Distinct from {@link HARMONY_MISMATCHED_TARGET}, which knows the target is
 * someone else's, and from {@link HARMONY_NO_TARGET}, whose "had not registered"
 * would be a plain untruth here.
 *
 * A guest still composing its first frame answers `0x0` and reaches this too,
 * so unlike the other refusals a longer budget CAN be the remedy — it is
 * offered second, after the reading the caller can act on directly.
 */
const HARMONY_UNPROBEABLE_TARGET =
  "A target registered while the instance was booting but never reported a display argent could " +
  "read, so it could not tell whether the target is this instance or another device that " +
  "reconnected, and did not guess. A guest that has not finished compositing reads this way too, " +
  'so call `list-devices` and drive the `kind: "device"` entry for the instance, or give the ' +
  "boot longer with `bootTimeoutMs`.";

/**
 * Said when the key rests on arrival alone, because no panel for this instance
 * was on record to check it against. Deliberately does not say WHY there was
 * none: the manager listing may have failed, or timed out, or not mentioned the
 * instance, or described a profile that does not key a single LCD — and nothing
 * here distinguishes those. The key is returned because it is the only
 * candidate that appeared and usually is the instance, but silently returning
 * an unchecked id is how every later tap ends up on someone else's device.
 */
const HARMONY_UNCONFIRMED_TARGET =
  "argent had no panel on record for this instance, so it could not check the target it returned " +
  "against one and matched on arrival timing alone. If another emulator or device reconnected " +
  "while the instance was booting, this may be its connect key; confirm against `list-devices` " +
  "before relying on it.";

/**
 * Said when the instance registered but never answered `uitest` in time. The
 * connect key is returned regardless — it is the right id, and an interaction
 * tool retried by hand may well work — so this is a caveat, not a failure.
 */
const HARMONY_NOT_DRIVABLE =
  "The instance registered with `hdc` but had not answered `uitest` before the boot budget " +
  "ran out, so `describe`, `screenshot` and the gesture tools may fail for a little longer. " +
  "Retry the first interaction, or give the boot longer with `bootTimeoutMs`.";

/**
 * Said when `hdc`'s device table could not be read for the whole wait.
 *
 * Distinct from {@link HARMONY_NO_TARGET}, which reports that nothing
 * registered: nothing is known here about whether the instance registered, and
 * the remedy is argent's own connector rather than a longer budget. The
 * pre-start snapshot refuses outright on this condition
 * (`BOOT_HARMONY_TARGET_LIST_FAILED`); by this point the instance has been
 * started, so here it is a caveat on a boot that did happen.
 */
const HARMONY_UNLISTABLE_TARGETS =
  "`hdc list targets` failed every time argent asked while the instance was booting, so it could " +
  "not tell whether the instance registered — this says nothing about the instance itself. Check " +
  "that `hdc` works (`hdc list targets`), then call `list-devices` and drive the " +
  '`kind: "device"` entry for the instance.';

/**
 * Said when the boot budget ran out before the target wait could read `hdc`'s
 * table even once — a `force` restart can spend all of it waiting out the
 * shutdown. Distinct from {@link HARMONY_UNLISTABLE_TARGETS}, which reports
 * listings that were asked for and failed: here `hdc` was never invoked by the
 * wait at all, so sending the caller to check it would misdiagnose a short
 * budget as a broken connector.
 */
const HARMONY_UNATTEMPTED_LISTING =
  "The boot budget ran out before argent could ask `hdc list targets` once while the instance " +
  "was coming up, so whether the instance registered was never checked — this says nothing " +
  'about `hdc` itself. Call `list-devices` and drive the `kind: "device"` entry for the ' +
  "instance once it appears.";

/** Said when the instance started but the connector that would reach it is missing. */
const HARMONY_NO_HDC =
  "The instance started, but `hdc` was not found, so argent cannot tell which target it " +
  "registered as and no interaction tool can reach it. Install DevEco Studio's device " +
  "connector (or put `hdc` on PATH), then call `list-devices`.";

/**
 * The targets `hdc` can drive right now, and whether the table could be read at
 * all.
 *
 * A failed listing is not an empty one. The pre-start snapshot already makes
 * that distinction — {@link connectedHarmonyKeys} raises
 * `BOOT_HARMONY_TARGET_LIST_FAILED` rather than treat an unreadable table as
 * "nothing connected" — and the wait that polls this needs it for the same
 * reason: a daemon that dies mid-boot otherwise reads as an instance that never
 * registered, and the caller is sent to raise `bootTimeoutMs` for a budget that
 * was never the problem. `ok` stays false only if EVERY attempt failed; one
 * `hdc` still coming up early in the boot is not a diagnosis.
 *
 * Hence the STRICT listing, as the snapshot uses: `hdc` exits 0 whatever
 * happens, so a dead server prints a diagnostic and no rows, which the tolerant
 * listing answers as `[]` — the one shape that makes `ok` mean nothing here.
 */
async function connectedHarmonyTargets(
  timeoutMs?: number
): Promise<{ ok: boolean; targets: Awaited<ReturnType<typeof listHarmonyHdcTargetsStrict>> }> {
  try {
    const targets = await listHarmonyHdcTargetsStrict(timeoutMs);
    return { ok: true, targets: targets.filter((t) => t.state === "Connected") };
  } catch {
    return { ok: false, targets: [] };
  }
}

/**
 * The connect keys `hdc` reports as `Connected` right now.
 *
 * The pre-start snapshot records that STATE, not mere membership in the
 * listing. A stopped instance leaves its row behind indefinitely
 * (`127.0.0.1:5555  TCP  Offline  localhost`, measured across `-stop`) and a
 * restart re-registers on the same port, so a snapshot of every listed key can
 * never see that instance arrive: every second boot of an instance this `hdc`
 * daemon has already seen, and every `force` restart, would spend the whole
 * budget concluding nothing registered and hand back an id no interaction tool
 * accepts.
 *
 * A key that is `Connected` here belongs to a guest this call did not start —
 * by this point the instance is known to be down, either because the manager
 * reported it stopped or because `-stop` was waited out — so excluding those,
 * and only those, is what leaves arrival meaning something.
 *
 * `Offline` is also what a connection blip leaves behind, so a foreign device
 * reconnecting is an arrival by this rule too. {@link waitForHarmonyTarget}
 * settles that with the panel the instance is configured with.
 *
 * A failed listing is not an empty one. Every later poll can shrug one off as
 * "nothing new yet", but the baseline cannot: empty, it makes every emulator
 * already connected count as this boot's arrival, and a peer off the same
 * device profile answers the same panel — so nothing downstream catches it and
 * the boot hands back a drivable id for the wrong device. Hence the STRICT
 * listing: `hdc` exits 0 for its own failures, so the tolerant one reports a
 * broken daemon as an empty device table. Retried once, since the daemon
 * restarting after a `-stop` is both the likely cause and one that clears,
 * then refused before anything is spawned.
 *
 * `stoppedInstance` names the instance a `force` restart has already stopped by
 * this point, since refusing here is the one path that leaves the host in a
 * state the caller did not ask for: they asked for a restart and get an error,
 * with the instance down and nothing started in its place. The other side of the
 * `force` path says so too, and staying quiet here would have the same failure
 * read as "nothing happened" depending only on which call failed.
 */
async function connectedHarmonyKeys(
  stoppedInstance: string | null,
  deadline: number
): Promise<Set<string>> {
  for (let attempt = 0; ; attempt++) {
    // The snapshot is spent from the same budget as everything after it. Left
    // on its own ceilings it runs 18s past the deadline on the `force` path —
    // a shutdown is given "the whole remaining budget" by design, so arriving
    // here with none left is the ordinary case, not the odd one — and the wait
    // it feeds then returns on its first line. A budget too small to trace the
    // key is refused here rather than overspent: the message below is the one
    // that says the instance is down and the restart has to be re-run.
    const budget = Math.max(1, deadline - Date.now());
    try {
      const targets = await listHarmonyHdcTargetsStrict(Math.min(HDC_LIST_TIMEOUT_MS, budget));
      return new Set(targets.filter((t) => t.state === "Connected").map((t) => t.connectKey));
    } catch (err) {
      if (attempt > 0 || Date.now() >= deadline) {
        throw new FailureError(
          "Could not read `hdc`'s device table while preparing to start the HarmonyOS instance, " +
            "so the target it registers under could not have been told apart from those already " +
            "connected: " +
            (err instanceof Error ? err.message : String(err)) +
            (stoppedInstance
              ? `. \`force\` had already stopped "${stoppedInstance}", which is still down — ` +
                "re-run boot-device to start it"
              : ""),
          {
            error_code: FAILURE_CODES.BOOT_HARMONY_TARGET_LIST_FAILED,
            failure_stage: "boot_harmony_target_snapshot",
            failure_area: "tool_server",
            // Carried up from whatever `hdc` did, not asserted: `runHdc` is the
            // frame that can tell a client SIGKILLed at its ceiling from one
            // that failed, and `getFailureSignal` takes the OUTERMOST signal —
            // so stamping `subprocess` here re-buckets the timeout it just
            // classified.
            error_kind: getFailureSignal(err)?.error_kind ?? "subprocess",
            failure_command: "hdc",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(HARMONY_TARGET_POLL_MS, Math.max(0, deadline - Date.now())))
      );
    }
  }
}

/**
 * Whether two panels are the same one, whichever way round it is composited.
 *
 * The guest reports its display as currently oriented, the manager as
 * configured, so comparing the axes pairwise would read a landscape instance as
 * a different device.
 */
function sameHarmonyPanel(
  a: { width: number; height: number },
  b: { width: number; height: number }
): boolean {
  return (
    Math.min(a.width, a.height) === Math.min(b.width, b.height) &&
    Math.max(a.width, a.height) === Math.max(b.width, b.height)
  );
}

/**
 * Whether a target could be the emulator this host just started.
 *
 * An emulator runs on the host and `hdc` reaches it over TCP loopback
 * (`127.0.0.1:5555`, measured), so a target the connector reports as `USB` is a
 * cable-attached handset and cannot be it. Anything else — including a null
 * connection, which is what a row too short to carry that column parses to — is
 * left eligible rather than filtered out, so an image that registers in some
 * shape not seen here still boots.
 */
function couldBeHarmonyEmulator(target: { connection: string | null }): boolean {
  return target.connection !== "USB";
}

/**
 * Start an instance, without waiting for it to finish.
 *
 * `Emulator -start` is not a launcher that hands off — it is the emulator's
 * supervisor, and it runs for as long as the emulator does (measured: a
 * `-start` awaited under a 15-minute budget returned only when that budget
 * killed it, taking the running emulator with it). So it is spawned detached
 * exactly as the Android emulator is, which also leaves the emulator up across
 * a tool-server restart. Its output goes to a log unique to this attempt so a
 * start that dies early can still be classified by what the manager printed.
 */
async function startHarmonyEmulator(
  instanceName: string
): Promise<{ exited: () => { reason: string; output: string } | null }> {
  const bin = await resolveHarmonyEmulator();
  if (!bin) {
    throw new FailureError(EMULATOR_NOT_FOUND, {
      error_code: FAILURE_CODES.HARMONY_EMULATOR_NOT_FOUND,
      failure_stage: "harmony_emulator_resolve_binary",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
      failure_command: "deveco_emulator",
    });
  }
  // Unique per attempt, not per instance: unlike Android there is no AVD lock
  // guaranteeing a single writer — two tool-server processes can boot the same
  // instance, and the coalescing map only covers one process's own window. A
  // shared name opened `"w"` let the loser truncate the winner's diagnostic
  // before anyone read it. Uniqueness means nothing reaps yesterday's logs, so
  // attempts older than a day are swept first — harmless, because nothing reads
  // a start log once its boot has returned, and every consumer of the exit
  // latch lives inside that boot's deadline-bounded waits.
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith("argent-harmony-") || !entry.endsWith(".log")) continue;
      try {
        if (Date.now() - statSync(join(tmpdir(), entry)).mtimeMs > HARMONY_LOG_TTL_MS) {
          rmSync(join(tmpdir(), entry), { force: true });
        }
      } catch {
        // best-effort — a file another process holds or already removed is fine
      }
    }
  } catch {
    // An unreadable tmpdir is handled by the guarded open below.
  }
  const safeName = instanceName.replace(/[^\w.-]/g, (c) => `%${c.codePointAt(0)!.toString(16)}`);
  const logPath = join(tmpdir(), `argent-harmony-${safeName}-${process.hrtime.bigint()}.log`);
  // An unwritable tmpdir is an environment problem the boot should survive
  // without its log — the diagnostic then reads "(nothing)" — rather than a raw
  // `Error` escaping ahead of any failure signal of its own.
  let logFd: number | null;
  try {
    logFd = openSync(logPath, "w");
  } catch {
    logFd = null;
  }
  const child = spawn(bin, ["-start", instanceName], {
    detached: true,
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
  });
  child.unref();
  // The child holds its own handle; close the parent's copy so a descriptor
  // does not leak per boot.
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // best-effort — the child keeps writing regardless
    }
  }

  let exit: { reason: string; output: string } | null = null;
  const record = (reason: string) => {
    if (exit) return;
    let output = "";
    try {
      output = readFileSync(logPath, "utf8");
    } catch {
      // no log to read — the reason alone has to carry it
    }
    exit = { reason, output };
  };
  child.on("exit", (code, signal) =>
    record(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)
  );
  // `spawn` can fail asynchronously (ENOENT, EACCES). An unhandled `error`
  // event would escape as an uncaught exception and take the tool-server with
  // it, so it goes through the same latch.
  child.on("error", (err) => record(`could not be spawned: ${err.message}`));

  return { exited: () => exit };
}

/**
 * What the boot says when the wait produced no connect key.
 *
 * A table rather than a chain of ternaries: keyed by the whole `reason` union,
 * so a reason added later is a compile error here instead of silently falling
 * through to "the instance had not registered" — which is the failure
 * {@link HARMONY_UNLISTABLE_TARGETS} exists because of.
 */
const HARMONY_NO_KEY_CAVEAT: Record<NonNullable<HarmonyTargetOutcome["reason"]>, string> = {
  ambiguous: HARMONY_AMBIGUOUS_TARGET,
  mismatched: HARMONY_MISMATCHED_TARGET,
  unprobeable: HARMONY_UNPROBEABLE_TARGET,
  unlistable: HARMONY_UNLISTABLE_TARGETS,
  unattempted: HARMONY_UNATTEMPTED_LISTING,
  none: HARMONY_NO_TARGET,
};

/**
 * What the wait for a target concluded.
 *
 * `reason` says why there is no key, and is read only when there is none;
 * `unconfirmed` marks a key that arrival alone picked out. Both feed the boot's
 * `note`, and each has to stay distinct there, since they send the caller
 * somewhere different: "ambiguous" and "mismatched" are decisions no budget
 * changes, while "none" and "unprobeable" can both be a boot still in progress,
 * and "unlistable" is argent's own connector rather than the instance at all.
 */
type HarmonyTargetOutcome = {
  key: string | null;
  unconfirmed?: boolean;
  reason?: "ambiguous" | "mismatched" | "unprobeable" | "unlistable" | "unattempted" | "none";
};

/**
 * `work`, or null once `deadline` has passed.
 *
 * Every probe these waits are built on carries its own fixed timeout and takes
 * no budget from its caller, so a poll that probes each arrival in turn runs for
 * that timeout times the number of arrivals — measured at 95s against a 30s
 * `bootTimeoutMs`, with two stale rows reconnecting beside the instance. The
 * budget is the caller's word on how long boot-device may take: the Android boot
 * above clamps its frame wait against the same deadline, "so the frame-wait
 * stage cannot push total elapsed time past bootTimeoutMs".
 *
 * Only the waiting is abandoned. The probe's own timeout still ends the process
 * it spawned, so nothing outlives the call that would not have anyway.
 *
 * Takes a thunk rather than a promise: an argument is evaluated before the call,
 * so a promise passed in has already spawned its `hdc` client by the time the
 * clock is read here — one per arrival, every one of them past the deadline.
 */
async function withinBudget<T>(start: () => Promise<T>, deadline: number): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const work = start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The connect key of the target that appears after a start, or null if none
 * does before `deadline`.
 *
 * Arrival, because nothing else joins the two: the `Emulator` manager reports a
 * configured `hw.hdc.port` but not the one a started instance registers under,
 * and `hdc` names connect keys and never mentions an instance. It is also the
 * one signal independent of how an emulator's key is spelled — measured as
 * `127.0.0.1:5555`, which is neither the hardware-serial shape a phone has nor
 * inside the range `-hdcPort` accepts.
 *
 * `checkAlive` is polled alongside, and throws if the emulator died: without it
 * a start that failed after the spawn returned would be indistinguishable from
 * one still booting, and would burn the whole budget before saying so.
 *
 * Exactly one *confirmed* arrival, or none. Arrival alone does not identify
 * anything once a second device can produce one, and returning the wrong key is
 * not a failed boot — it is a drivable id, so every later tap and keystroke
 * lands on that device instead. So USB arrivals are excluded outright (a
 * host-local emulator is not on a cable), a candidate is confirmed against
 * `expected` — the panel the instance is configured with, which the guest
 * reports back as its `render resolution` — and two confirmed arrivals are
 * refused rather than guessed between.
 *
 * The panel check is a filter and never a requirement. An instance whose config
 * does not describe a single panel passes `expected: null`, and its arrival is
 * taken on arrival alone, flagged `unconfirmed` so the caller is told the id
 * rests on timing rather than on identity.
 *
 * Nothing is rejected for good. A target that cannot be probed yet is left
 * pending — a row reaches `Connected` before its render service answers — and
 * so is one answering `0x0`, which is that service up but not yet composited.
 * Even a target answering someone else's panel is only skipped for that poll:
 * the reading is not final, since this platform's flagship form factors are
 * foldables whose resolution changes with the fold, and a boot is when a
 * guest's panel is least settled. Latching a verdict off one early reading
 * would disqualify the instance argent itself started for the whole budget.
 *
 * What this does NOT cover: two instances sharing one device profile, whose
 * panels are identical by construction; and a second emulator registering
 * during the window but outside it — started from DevEco Studio, or by a
 * concurrent `boot-device` for another instance, which `inFlightHarmonyBoots`
 * does not coalesce. Nothing in `hdc` or the manager ties a key to an instance,
 * so closing those needs a lock across every harmony boot on the host, which
 * would head-of-line block them all on one slow start.
 */
async function waitForHarmonyTarget(
  before: Set<string>,
  deadline: number,
  checkAlive: () => void,
  expected: { width: number; height: number } | null
): Promise<HarmonyTargetOutcome> {
  let sawMismatch = false;
  let sawUnprobeable = false;
  // Every listing so far having failed is a different answer from none having
  // arrived, and it is latched rather than sampled: `hdc` is often still coming
  // up on the first poll of a cold boot, so only a table that was never readable
  // is worth reporting as one. Whether the wait ever got to ask at all is a
  // third answer again — a `force` restart can spend the whole budget before
  // this loop's first look, and blaming `hdc` for listings it was never asked
  // for would send the caller hunting a broken connector.
  let listedOnce = false;
  let asked = false;
  // What was seen beats what was not: a target that registered and was declined
  // says more than an unreadable table, which in turn says more than nothing
  // having arrived.
  const noKeyReason = (): HarmonyTargetOutcome["reason"] =>
    sawMismatch
      ? "mismatched"
      : sawUnprobeable
        ? "unprobeable"
        : listedOnce
          ? "none"
          : asked
            ? "unlistable"
            : "unattempted";
  for (;;) {
    // The listing is bounded by the budget too, not just the probes it feeds:
    // `hdc list targets` carries its own 8s ceiling, so a daemon slow enough to
    // reach it would return this wait a quarter past `bootTimeoutMs`. Bounded
    // rather than abandoned, since a listing that lands at the deadline still
    // names the key this whole wait exists to find.
    const budget = deadline - Date.now();
    if (budget <= 0) {
      // Polled before giving up, not only mid-loop: an emulator that died inside
      // the final poll interval — the sleep at the bottom clamps to `remaining`,
      // so expiry always lands here — would otherwise fall through to a note
      // telling the caller to raise the budget for a start that crashed.
      checkAlive();
      return { key: null, reason: noKeyReason() };
    }
    const listing = await connectedHarmonyTargets(Math.min(HDC_LIST_TIMEOUT_MS, budget));
    asked = true;
    if (listing.ok) listedOnce = true;
    const arrived = listing.targets.filter(
      (t) => !before.has(t.connectKey) && couldBeHarmonyEmulator(t)
    );
    const confirmed: string[] = [];
    for (const target of arrived) {
      if (!expected) {
        confirmed.push(target.connectKey);
        continue;
      }
      const display = await withinBudget(
        () => harmonyDisplay(target.connectKey).catch(() => null),
        deadline
      );
      // A guest that has not composited yet answers `0x0`. The manager side of
      // this comparison refuses zero as a panel for the same reason, so reading
      // it as someone else's would have the two sides disagree about the one
      // value that joins them. A probe the budget cut short lands here too:
      // unprobed and unrejected are the same thing to the poll after it, and
      // once the budget is gone the rest of this round costs nothing.
      if (!display || display.width <= 0 || display.height <= 0) {
        sawUnprobeable = true;
        continue;
      }
      if (sameHarmonyPanel(display, expected)) confirmed.push(target.connectKey);
      else sawMismatch = true;
    }
    if (confirmed.length === 1) {
      return { key: confirmed[0]!, unconfirmed: !expected };
    }
    // Two confirmed arrivals is a refusal to guess, not a slow boot, and it is
    // answered here rather than latched: polling on would spend the rest of the
    // budget on a decision already made, and would turn the refusal into a
    // guess the moment one of the two flapped and left the other alone.
    if (confirmed.length > 1) return { key: null, reason: "ambiguous" };
    checkAlive();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // A target that registered and was declined, or one that registered and
      // never answered, are both distinct from nothing arriving at all — the
      // budget is not what failed, so the caller must not be sent to raise it.
      return { key: null, reason: noKeyReason() };
    }
    await new Promise((r) => setTimeout(r, Math.min(HARMONY_TARGET_POLL_MS, remaining)));
  }
}

/**
 * Wait until the guest answers `uitest`, answering whether it did.
 *
 * A target reports `Connected` as soon as `hdc` can reach the guest's daemon,
 * which is not the same as the window service being up: `uitest dumpLayout`
 * answers `DumpLayout failed:Get window nodes failed` for a window after that,
 * so a key returned on `Connected` alone can fail every interaction tool for
 * seconds while looking drivable. Every other platform gates its boot on a
 * readiness signal — `sys.boot_completed` and a first frame on Android,
 * `simctl bootstatus` on iOS, `waitForVvdRunning` on Vega — and this is
 * HarmonyOS'.
 *
 * The probe is a real `dumpLayout` rather than something cheaper because that
 * is the call the gap is in; `hidumper` answers throughout it.
 *
 * `checkAlive` is polled here for the same reason the wait for the target polls
 * it: an emulator that dies in this window answers no probe, which is exactly
 * what one still starting its window service looks like. Without it the manager
 * can be gone — with its diagnostic already latched — for the whole remaining
 * budget, and the boot still reports a drivable id under a note telling the
 * caller to retry.
 */
async function waitForHarmonyDrivable(
  connectKey: string,
  deadline: number,
  checkAlive: () => void
): Promise<boolean> {
  const probePath = join(tmpdir(), `argent-harmony-bootprobe-${process.hrtime.bigint()}.json`);
  // Non-null only while a probe is in flight, which past the deadline is a probe
  // nothing is waiting for any more.
  let inFlight: Promise<unknown> | null = null;
  try {
    for (;;) {
      // Asked before it is spawned, not only before it is awaited: a target
      // confirmed on arrival alone (no panel to check it against) can resolve at
      // the deadline itself, and a probe started then is one nothing will ever
      // read.
      const budget = deadline - Date.now();
      if (budget <= 0) {
        checkAlive();
        return false;
      }
      // Capped by the budget as well as by `uitest`'s own ceiling: a probe this
      // wait abandons at the deadline still holds the device's `uitest` queue
      // until its client is killed, and the retry the caller is about to be told
      // to make is what waits behind it.
      const probe = harmonyDumpLayout(
        connectKey,
        probePath,
        Math.min(UITEST_TIMEOUT_MS, budget)
      ).then(
        () => true,
        () => false
      );
      inFlight = probe;
      const answered = await withinBudget(() => probe, deadline);
      if (answered !== null) inFlight = null;
      if (answered) return true;
      checkAlive();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(HARMONY_TARGET_POLL_MS, remaining)));
    }
  } finally {
    // A probe abandoned at the deadline can still write `probePath` after this
    // point, so its removal waits it out — bounded by the probe's own timeout —
    // rather than racing it and leaving the dump behind in the temp directory.
    // That one is not awaited, since the budget that would pay for it is what
    // just ran out; on every other path the dump is gone before this returns.
    const remove = () => rm(probePath, { force: true }).catch(() => {});
    if (inFlight) void inFlight.then(remove);
    else await remove();
  }
}

/** Resolve when the manager has exited, or when `graceMs` has passed. */
async function waitForHarmonyExit(
  emulator: { exited: () => unknown },
  graceMs: number
): Promise<void> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (emulator.exited()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(HARMONY_EXIT_POLL_MS, remaining)));
  }
}

/**
 * Wait until the manager stops reporting the instance as running, answering
 * whether it did.
 *
 * `-stop` returns as soon as it has asked, not once the emulator is gone, and
 * the guest's `hdc` endpoint dies well before the process does — so a restart
 * that waited on the target dropping would call `-start` into "this emulator
 * instance is already running" (measured). `isRunning` is the one signal that
 * tracks the process itself. An unreadable listing answers nothing, so it keeps
 * waiting rather than assuming the instance is gone.
 */
async function waitForHarmonyInstanceStopped(name: string, deadline: number): Promise<boolean> {
  for (;;) {
    // Bounded for the same reason as the arrival wait's listing: this one
    // carries a 6s ceiling of its own, and a `force` restart spends one budget
    // on the shutdown and the boot that follows it.
    const budget = deadline - Date.now();
    if (budget <= 0) return false;
    const instances = await listHarmonyInstances(Math.min(HARMONY_LIST_TIMEOUT_MS, budget)).catch(
      () => null
    );
    // Only a listing WITH ROWS can say the instance stopped. A `-list` that ran
    // and printed a diagnostic resolves to `[]` rather than throwing, and the
    // stopped instance itself is still a row (with `isRunning` false), so an
    // empty answer is the unreadable one — and reading it as "gone" would
    // `-start` into an instance still running.
    if (instances?.length && !instances.some((i) => i.name === name && i.running)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(HARMONY_TARGET_POLL_MS, remaining)));
  }
}

async function bootHarmonyImpl(params: {
  instanceName: string;
  bootTimeoutMs: number;
  force?: boolean;
}): Promise<HarmonyBootResult> {
  await ensureDep("harmony-emulator");
  const bootDeadline = Date.now() + params.bootTimeoutMs;

  // Answers two questions: whether this instance is already up, and — if the
  // start fails — whether the host has any at all. `null` is a listing that
  // itself failed and answers neither, so it neither blocks a start nor lets
  // one be blamed on a host with no instances.
  const instances = await listHarmonyInstances(
    Math.min(HARMONY_LIST_TIMEOUT_MS, Math.max(1, bootDeadline - Date.now()))
  ).catch(() => null);
  // A name the manager does not know can only fail, and the listing that names
  // the caller's typo is already in hand — the same refusal Android makes off
  // `emulator -list-avds`. Left to `-start`, the boot instead spends the budget
  // and answers with the manager's own words, which name nothing that exists.
  //
  // Only a listing WITH ROWS refuses. An empty one is not the same claim: a
  // `-list` that ran but printed a diagnostic — "Cannot find image" on a host
  // whose images were never downloaded — comes back from `listHarmonyInstances`
  // as `[]` too, and refusing on that would block a boot of an instance the host
  // has. That case is still left to the start, whose failure says as much.
  if (instances?.length && !instances.some((i) => i.name === params.instanceName)) {
    throw new FailureError(
      `HarmonyOS emulator instance "${params.instanceName}" not found. ` +
        `Available: ${instances.map((i) => i.name).join(", ")}.`,
      {
        error_code: FAILURE_CODES.BOOT_HARMONY_INSTANCE_NOT_FOUND,
        failure_stage: "boot_harmony_instance_lookup",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  const alreadyRunning =
    instances?.some((i) => i.name === params.instanceName && i.running) ?? false;

  if (alreadyRunning && !params.force) {
    return {
      platform: "harmony",
      udid: harmonyEmulatorId(params.instanceName),
      instanceName: params.instanceName,
      booted: true,
      note: HARMONY_ALREADY_RUNNING,
    };
  }
  if (alreadyRunning) {
    // Bounded by the budget like every wait after it: `-stop` returns as soon as
    // it has asked, but its own 30s ceiling is the whole of a minimum budget,
    // and a manager slow to answer would leave nothing for the shutdown this
    // call still has to wait out.
    const stopped = await runHarmonyEmulator(
      ["-stop", params.instanceName],
      Math.min(EMULATOR_TIMEOUT_MS, Math.max(1, bootDeadline - Date.now()))
    );
    const stopDiagnostic = emulatorFailure(stopped);
    if (stopDiagnostic) {
      throw new FailureError(
        `Failed to stop HarmonyOS emulator "${params.instanceName}" before restarting it: ${stopDiagnostic}`,
        {
          error_code: FAILURE_CODES.BOOT_HARMONY_STOP_FAILED,
          failure_stage: "boot_harmony_stop",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "deveco_emulator",
        }
      );
    }
    // The whole remaining budget rather than a slice of it: an instance still up
    // leaves nothing worth spending the rest on, since starting it can only
    // report that it is already running.
    if (!(await waitForHarmonyInstanceStopped(params.instanceName, bootDeadline))) {
      throw new FailureError(
        `HarmonyOS emulator "${params.instanceName}" was still running when the ` +
          `${Math.round(params.bootTimeoutMs / 1_000)}s budget ran out after \`-stop\`, so ` +
          "starting it now would only report that it is already running. Re-run with a larger " +
          "bootTimeoutMs, or stop the instance from DevEco Studio.",
        {
          error_code: FAILURE_CODES.BOOT_HARMONY_STOP_TIMEOUT,
          failure_stage: "boot_harmony_stop_wait",
          failure_area: "tool_server",
          error_kind: "timeout",
          failure_command: "deveco_emulator",
        }
      );
    }
  }

  // Asked rather than waited out: with no connector there is no target list to
  // watch, so the wait would spend the whole budget concluding that nothing
  // registered — blaming the emulator for the connector's absence. Asked before
  // the snapshot because the snapshot is that same target list, and refuses the
  // boot when it cannot be read.
  const hdcAvailable = Boolean(await resolveHdc());

  // Snapshot immediately before the start, so a target already driveable
  // (another emulator, a phone on USB) is excluded by identity rather than by
  // any assumption about how an emulator's key is spelled. Reaching `Connected`
  // after this point is what marks the instance just booted — including on the
  // key it held before, since a stopped instance's row survives as `Offline`.
  // `alreadyRunning` can only still be set on the `force` path — the other
  // return above — so it is exactly "this call has stopped the instance".
  const before = hdcAvailable
    ? await connectedHarmonyKeys(alreadyRunning ? params.instanceName : null, bootDeadline)
    : new Set<string>();
  // The panel this instance is configured with, which the guest reports back as
  // its `render resolution` — the only thing that separates the instance
  // reconnecting from another device doing the same. Read before the start
  // because the listing is already in hand; a config's panel does not change.
  const expectedPanel = instances?.find((i) => i.name === params.instanceName)?.display ?? null;

  const emulator = await startHarmonyEmulator(params.instanceName);

  // Set once the target wait resolves a key, so a death reported from the
  // readiness wait can say which side of registration it happened on.
  let resolvedKey: string | null = null;
  const assertEmulatorAlive = () => {
    {
      const exit = emulator.exited();
      if (!exit) return;
      // The exit code is no verdict: `-start` on a missing instance exits 1
      // while the manager's other failures exit 0, so the diagnostic it
      // printed is the only signal (see `harmony-cli.ts`).
      const diagnostic = emulatorFailure({ stdout: exit.output, stderr: "" });
      if (!diagnostic) {
        // Both waits poll this, and they sit on opposite sides of the key being
        // resolved — saying "before it registered" during the readiness wait
        // would deny the registration the failing probe is aimed at.
        const when = resolvedKey
          ? `while "${params.instanceName}" (\`${resolvedKey}\`) was still coming up`
          : `before "${params.instanceName}" registered with \`hdc\``;
        throw new FailureError(
          `The HarmonyOS emulator manager exited (${exit.reason}) ${when}` +
            `, so nothing is running to drive. It printed: ${exit.output.trim() || "(nothing)"}`,
          {
            error_code: FAILURE_CODES.BOOT_HARMONY_MANAGER_EXITED,
            failure_stage: "boot_harmony_manager_exit",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "deveco_emulator",
          }
        );
      }
      const imageMissing =
        isChinaOnlyRestriction(diagnostic) || diagnostic.includes("Cannot find image");
      // Only the manager's own words justify blaming the region; an empty
      // instance list is merely consistent with it.
      const cause = imageMissing
        ? ` ${HARMONY_IMAGE_RESTRICTION}`
        : instances?.length === 0
          ? ` ${HARMONY_NO_INSTANCES}`
          : "";
      throw new FailureError(
        cause
          ? `Failed to start HarmonyOS emulator "${params.instanceName}".${cause} The manager reported: ${diagnostic}`
          : `Failed to start HarmonyOS emulator "${params.instanceName}": ${diagnostic}`,
        {
          error_code: FAILURE_CODES.BOOT_HARMONY_START_FAILED,
          failure_stage: "boot_harmony_start",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "deveco_emulator",
        }
      );
    }
  };

  // Without a connector there is no target list to watch, but the manager can
  // still be watched for a short grace: otherwise a start that fails — a missing
  // image, an instance already running — is reported as `booted: true` under a
  // note whose first clause, "the instance started", nothing has checked.
  //
  // Asking once is not enough. Nothing between the spawn and here does any I/O
  // at all, so a single check runs microtasks after the spawn, before the child
  // could have exited. The grace is small and bounded because a failing
  // `-start` prints and exits at once — this must not become the whole-budget
  // wait the connector-absent path exists to avoid.
  if (!hdcAvailable) {
    // Clamped against the boot deadline like every other wait on this path: the
    // grace is a ceiling, not an entitlement of its own, and a caller with 2s of
    // budget left must not be answered 3s past it.
    const grace = Math.min(HARMONY_NO_HDC_GRACE_MS, Math.max(0, bootDeadline - Date.now()));
    if (grace > 0) await waitForHarmonyExit(emulator, grace);
    assertEmulatorAlive();
  }

  const outcome: HarmonyTargetOutcome = hdcAvailable
    ? await waitForHarmonyTarget(before, bootDeadline, assertEmulatorAlive, expectedPanel)
    : { key: null };
  const connectKey = outcome.key;

  // Registered is not driveable. The remaining budget rather than a slice of
  // it: the key is already in hand, so there is nothing else left to spend it
  // on, and an expiry is reported rather than walked into.
  resolvedKey = connectKey;
  const drivable = connectKey
    ? await waitForHarmonyDrivable(connectKey, bootDeadline, assertEmulatorAlive)
    : false;

  // Collected rather than picked: a key can be both unchecked and not yet
  // answering, and dropping either caveat for the other would leave the payload
  // asserting something the boot did not establish.
  const caveats: string[] = [];
  if (connectKey) {
    if (outcome.unconfirmed) caveats.push(HARMONY_UNCONFIRMED_TARGET);
    if (!drivable) caveats.push(HARMONY_NOT_DRIVABLE);
  } else if (!hdcAvailable) {
    caveats.push(HARMONY_NO_HDC);
  } else {
    caveats.push(HARMONY_NO_KEY_CAVEAT[outcome.reason ?? "none"]);
  }
  const note = caveats.length > 0 ? caveats.join(" ") : undefined;

  return {
    platform: "harmony",
    udid: connectKey ? harmonyDeviceId(connectKey) : harmonyEmulatorId(params.instanceName),
    instanceName: params.instanceName,
    booted: true,
    ...(note ? { note } : {}),
  };
}

function bootHarmony(params: {
  instanceName: string;
  bootTimeoutMs: number;
  force?: boolean;
}): Promise<HarmonyBootResult> {
  // Keyed on the instance alone, as the Android map keys on the AVD name. Two
  // boots that would do the same work share one run; a boot with the opposite
  // `force` value SERIALIZES behind the in-flight one instead, because letting
  // a plain and a forced boot reach `-start` together started the instance
  // twice (measured: one caller told BOOT_HARMONY_MANAGER_EXITED while the
  // other handed back the booted connect key). Waiting the prior attempt out
  // keeps `force`'s restart real — it runs its own stop+start against whatever
  // the first boot left behind.
  const key = params.instanceName;
  const force = Boolean(params.force);
  const existing = inFlightHarmonyBoots.get(key);
  if (existing && existing.force === force) return existing.promise;
  const tracked = (async () => {
    if (existing) {
      try {
        await existing.promise;
      } catch {
        // The prior attempt failed; this one still runs and reports for itself.
      }
    }
    return bootHarmonyImpl(params);
  })().finally(() => {
    if (inFlightHarmonyBoots.get(key)?.promise === tracked) inFlightHarmonyBoots.delete(key);
  });
  inFlightHarmonyBoots.set(key, { force, promise: tracked });
  return tracked;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
  harmony: { emulator: true },
};

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  return {
    id: "boot-device",
    interaction: {
      startedMsg: ({ params }) => `Starting ${bootTarget(params)}`,
      completedMsg: ({ params }) => `Started ${bootTarget(params)}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to start ${bootTarget(params)}: ${failureSignal.error_code}`,
    },
    description: `Start an iOS simulator, launch an Android emulator, start a Vega (Fire TV) Virtual Device, start a HarmonyOS emulator, or spawn an Electron app and wait until it is ready to accept interactions.
Pick the platform by which argument you pass: 'udid' for an iOS simulator from list-devices, 'avdName' for an Android AVD (a serial is assigned automatically), 'vvdImage' for a Vega VVD (the 'vvdImage' of a vega device from list-devices, e.g. 'tv'), 'harmonyInstance' for a HarmonyOS emulator instance (the 'name' of a harmony device from list-devices), or 'electronAppPath' for an Electron app (a CDP remote-debugging port is picked automatically, or pass 'electronPort' to fix one).
Use at the start of a session once you have picked a target.
Returns a tagged payload: { platform: 'ios', udid, booted } or { platform: 'android', serial, avdName, booted } or { platform: 'vega', serial, vvdImage, booted } or { platform: 'harmony', udid, instanceName, booted, note? } or { platform: 'chromium', id, port, pid, booted } (an Electron app boots as a Chromium/CDP device).
Android boots take 2–10 minutes depending on machine and cold/warm state; the tool transparently hot-boots from the AVD's default_boot snapshot when usable and falls back to cold boot otherwise. Vega starts the single SDK-managed VVD via the vega CLI (~10s) and returns once it reports running. If an Android/Electron boot stage fails, the tool terminates the device it spawned so the next retry starts clean.
HarmonyOS hands the instance to DevEco Studio's Emulator manager, then waits for it to register with 'hdc' and returns its connect key as 'udid' — the id the interaction tools drive. The manager itself reports no readiness signal and never names a port, so an instance that is already running is left alone unless you pass 'force: true'; when the key could not be resolved the payload names the instance instead, and a 'note' is present whenever the boot left something unproven — no key and why, or a key that is not yet answering or could not be checked against the instance. Huawei serves the emulator images only within mainland China, so a host outside it usually has no instance to start; one that already has an image is started like any other.`,
    alwaysLoad: true,
    searchHint:
      "boot start launch simulator emulator avd device session ios android vega vvd firetv harmony harmonyos deveco cold hot",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const hasUdid = Boolean(params.udid);
      const hasAvd = Boolean(params.avdName);
      const hasVega = Boolean(params.vvdImage);
      const hasHarmony = Boolean(params.harmonyInstance);
      const hasElectron = Boolean(params.electronAppPath);
      const provided = [hasUdid, hasAvd, hasVega, hasHarmony, hasElectron].filter(Boolean).length;
      if (provided !== 1) {
        throw new FailureError(
          "Provide exactly one of `udid` (iOS), `avdName` (Android), `vvdImage` (Vega VVD), `harmonyInstance` (HarmonyOS), or `electronAppPath` (Electron).",
          {
            error_code: FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID,
            failure_stage: "boot_device_target_selection",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      if (hasUdid) {
        const platform = classifyDevice(params.udid!);
        if (platform === "ios-remote") {
          return bootIosRemote(params.udid!, registry, params.force);
        }
        // A HarmonyOS id reaching here is an emulator instance — the
        // capability gate admits only `kind: "emulator"` — so route it to the
        // emulator manager rather than to simctl, which would reject it as an
        // unknown iOS udid.
        if (platform === "harmony") {
          return bootHarmony({
            instanceName: harmonyInstanceName(params.udid!),
            bootTimeoutMs: params.bootTimeoutMs ?? HARMONY_BOOT_TIMEOUT_MS,
            force: params.force,
          });
        }
        return bootIos(params.udid!, registry, params.force, params.headless);
      }
      if (hasAvd) {
        return bootAndroid({
          avdName: params.avdName!,
          bootTimeoutMs: params.bootTimeoutMs ?? 480_000,
          force: params.force,
          // An explicit argument always wins; the `boot-sound` flag only moves
          // the default when the caller left `sound` unset. Read live per call
          // so `argent enable/disable boot-sound` applies without a restart.
          sound: params.sound ?? isFlagEnabled("boot-sound"),
        });
      }
      if (hasVega) {
        return bootVega({
          vvdImage: params.vvdImage!,
          bootTimeoutMs: params.bootTimeoutMs ?? 120_000,
          force: params.force,
        });
      }
      if (hasHarmony) {
        return bootHarmony({
          instanceName: harmonyInstanceName(params.harmonyInstance!),
          bootTimeoutMs: params.bootTimeoutMs ?? HARMONY_BOOT_TIMEOUT_MS,
          force: params.force,
        });
      }
      return bootElectronApp({
        appPath: params.electronAppPath!,
        port: params.electronPort,
        extraArgs: params.electronArgs,
      });
    },
  };
}

import { execFile, spawn, type StdioOptions } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
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
  subprocessFailureMetadata,
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
import {
  clearAutomationEnabledOrWarn,
  ensureAutomationEnabled,
  setAccessibilityPrefsPreBoot,
} from "../../utils/ax-prefs";
import {
  adbShell,
  checkSnapshotLoadable,
  emulatorSupportsFlag,
  hasDefaultBootSnapshot,
  listAndroidDevices,
  listAvds,
  readEmulatorConsoleAvdName,
  resolveEmulatorOrThrow,
  runAdb,
  waitForBootCompleted,
  type AndroidDevice,
} from "../../utils/adb";
import {
  __clearReadOnlyBootsForTesting,
  forgetReadOnlyBoot,
  readOnlyBootEntries,
  rememberReadOnlyBoot,
} from "../../utils/android-read-only-boots";
import { ensureDep } from "../../utils/check-deps";
import {
  consoleOwnership,
  listEmulatorPidsForAvd,
  listEmulatorProcessesForAvd,
  readEmulatorProcessesForAvd,
  type EmulatorProcess,
} from "../../utils/emulator-process";
import { linuxBootDiagnostics } from "../../utils/linux-preflight";
import { scanIosSimulators, simctlListTimeoutAdvice } from "../../utils/ios-devices";
import { launchSimulatorApp } from "../../utils/simulator-app-launch";
import { deviceSetForUdid, simctlPrefix } from "../../utils/ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../../utils/simctl-config";
import {
  androidGuestVulkanFromEnv,
  androidHeadlessFromEnv,
  iosHeadlessFromEnv,
} from "../../utils/no-window-env";
import {
  assertHarmonyEnabled,
  classifyDevice,
  harmonyInstanceName,
  isAndroidEmulatorSerial,
  stripRemotePrefix,
  harmonyDeviceId,
  harmonyEmulatorId,
} from "../../utils/device-info";
import {
  externalClaimForNativeId,
  isExternalId,
  isIosPhysicalUdid,
  nativeIdPlatform,
} from "../../utils/external-devices";
import { InvalidToolInputError, isFlagOffered, MACOS_APPS_FLAG } from "../../utils/capability";
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
import { HARMONY_FLAG } from "../../utils/harmony-flag";
import { FLAG_META_KEY, renderFlagGated } from "../../utils/flag-gated-text";
import { UITEST_TIMEOUT_MS, harmonyDisplay, harmonyDumpLayout } from "../../utils/harmony-uitest";
import {
  assertElectronPortFree,
  bootElectronApp,
  forgetElectronLaunchSpec,
  withPortLock,
  type ElectronBootResult,
} from "./boot-electron";
import { bootMacosApp, type MacosBootResult } from "./boot-macos";

const execFileAsync = promisify(execFile);

type AndroidBootResult = {
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
  note?: string;
};

type IosBootResult =
  | { platform: "ios"; udid: string; booted: true; note?: string }
  | { platform: "ios"; udid: string; booted: false; prepared: true };

type BootDeviceResult =
  | IosBootResult
  | { platform: "ios-remote"; udid: string; booted: true }
  | AndroidBootResult
  | VegaBootResult
  | HarmonyBootResult
  | ElectronBootResult
  | MacosBootResult
  | NativeDevtoolsInitFailedResult;

function bootTarget(params: BootDeviceParams): string {
  return (
    params.udid ??
    params.avdName ??
    params.vvdImage ??
    params.harmonyInstance ??
    params.electronAppPath ??
    params.macosAppPath ??
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

// macOS: guest Vulkan crashes Chrome's GPU process on every host backend
// (lavapipe, SwiftShader, MoltenVK). Passed both ways so
// ~/.android/advancedFeatures.ini cannot override `guestVulkan`.
function guestVulkanArgs(guestVulkan: boolean): string[] {
  if (process.platform !== "darwin") return [];
  return ["-feature", guestVulkan ? "Vulkan" : "-Vulkan"];
}

// Only `ro.boot.hardware.vulkan` reliably tracks `-feature -Vulkan`;
// `ro.hardware.vulkan` stays set on some images (API 34).
async function runningGuestVulkanNote(
  serial: string,
  guestVulkan: boolean
): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const prop = await adbShell(serial, "getprop ro.boot.hardware.vulkan", { timeoutMs: 5_000 })
    .then((out) => out.trim())
    .catch(() => null);
  if (prop === null || (prop !== "") === guestVulkan) return undefined;
  return guestVulkan
    ? "This emulator was already running without guest Vulkan, so apps find no Vulkan device. Pass `force: true` to reboot it with guest Vulkan."
    : "This emulator was already running with guest Vulkan, which can crash Chrome's GPU process. Pass `force: true` to reboot it without guest Vulkan.";
}

// Poll cadences for the boot state machine: they bound latency, not
// correctness. Deliberately conservative so a hung adb on the default 30s
// timeout is not re-spawned every few ms.
const BOOT_POLL_INTERVALS_MS = {
  serialByAvd: 1_500, // findSerialByAvdName: re-scan when >1 new emulator appeared
  adbRegister: 1_000, // attemptBoot stage 2: re-scan adb devices for the new serial
  earlyExit: 500, // createEarlyExitRacer: re-check the crash latch during a blocking adb call
  serialGone: 500, // awaitEmulatorsGone, awaitOwnEmulatorSettled: re-check for a dying emulator
} as const;

// How long a killed emulator may stay listed by adb, or its process alive,
// before the next spawn.
const EMULATOR_GONE_BUDGET_MS = 30_000;

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
 * before the composite hydrates. Only stop an unusable emulator if the caller
 * can replace it.
 */
async function assertScreencapAlive(
  serial: string,
  onFailure: "replace" | "preserve",
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
  if (onFailure === "replace") await killEmulatorQuietly(serial);
  throw new FailureError(
    `hot-boot composite did not restore within ${budgetMs / 1000}s — \`screencap\` last returned ` +
      `${JSON.stringify(lastReading ?? "no probe response")}. ` +
      (onFailure === "replace"
        ? "Falling back to cold boot so screenshots are usable."
        : `Left ${serial} running. Pass \`force: true\` to replace it.`),
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

/** The first of `among` that adb lists as a healthy emulator running `avdName`. */
async function findSerialByAvdName(
  avdName: string,
  among: string[],
  deadline: number
): Promise<string | null> {
  while (Date.now() < deadline) {
    const devices = await listAndroidDevices().catch(() => []);
    const match = devices.find(
      (d) => d.isEmulator && d.avdName === avdName && among.includes(d.serial)
    );
    if (match) return match.serial;
    await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVALS_MS.serialByAvd));
  }
  return null;
}

async function listEmulatorSerials(): Promise<string[]> {
  // 3 s per poll — a hung adb daemon on the default 30 s timeout would eat
  // the whole outer stage budget in a single call.
  const { stdout } = await runAdb(["devices"], { timeoutMs: 3_000 }).catch(() => ({
    stdout: "",
    stderr: "",
  }));
  const now: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(emulator-\d+)\s+/);
    if (m) now.push(m[1]!);
  }
  return now;
}

async function listNewEmulatorSerials(before: Set<string>): Promise<string[]> {
  return (await listEmulatorSerials()).filter((s) => !before.has(s));
}

/**
 * Wait (bounded) for killed emulators to drop off adb. `adb emu kill` returns
 * before qemu exits, and the next spawn usually takes the freed console port, so
 * it registers under the killed emulator's serial: snapshotting the device list
 * before that serial is gone would count the new emulator as pre-existing.
 */
async function awaitEmulatorsGone(serials: string[]): Promise<void> {
  const deadline = Date.now() + EMULATOR_GONE_BUDGET_MS;
  while (serials.length > 0 && Date.now() < deadline) {
    const listed = await listEmulatorSerials();
    if (!serials.some((s) => listed.includes(s))) return;
    await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVALS_MS.serialGone));
  }
}

function isRunningAvd(device: AndroidDevice, avdName: string): boolean {
  return device.isEmulator && device.avdName === avdName && device.state === "device";
}

/**
 * Wait (bounded) while an emulator process for this AVD is alive but not
 * healthy in adb. That is an emulator killed outside argent (window closed,
 * crash, `adb emu kill`) and still shutting down, which takes up to ~20 s, or
 * one somebody else started that is still coming up. adb lists it as `offline`
 * or as `device` with getprop failing, so it reads as neither ours nor gone, and
 * a spawn now would collide with it on the AVD lock or come up on its freed
 * console port, which the before-spawn snapshot already holds, and never count
 * as new.
 *
 * The process table names the AVD when adb cannot. Only this AVD's process is
 * waited on, so an unrelated frozen emulator costs nothing here. Resolves when
 * the process exits (null) or when the emulator answers getprop with this AVD,
 * returning the device list that showed it so the caller can reuse it. Without
 * `ps` (Windows) there is nothing to wait on and the spawn proceeds as before.
 */
async function awaitOwnEmulatorSettled(
  avdName: string,
  deadline: number
): Promise<AndroidDevice[] | null> {
  let healthy: AndroidDevice[] | null = null;
  let listing: Promise<void> | null = null;
  while (Date.now() < deadline) {
    if (healthy) return healthy;
    if ((await listEmulatorPidsForAvd(avdName)).length === 0) return null;
    // A dying emulator listed as `device` holds listAndroidDevices for
    // ENRICH_TIMEOUT_MS per getprop, so the listing runs alongside the process
    // poll rather than pacing it: the exit is still noticed within one interval.
    listing ??= listAndroidDevices()
      .then((devices) => {
        if (devices.some((d) => isRunningAvd(d, avdName))) healthy = devices;
      })
      .catch(() => {})
      .finally(() => {
        listing = null;
      });
    await new Promise((r) =>
      setTimeout(r, Math.min(BOOT_POLL_INTERVALS_MS.serialGone, deadline - Date.now()))
    );
  }
  return healthy;
}

/**
 * Wait until no emulator process of `avdName` matching `filter` runs, or the
 * deadline passes (a deadline in the past checks once). Returns those still
 * running; empty without `ps` (Windows), where nothing can be checked.
 */
async function awaitEmulatorProcessesGone(
  avdName: string,
  filter: (p: EmulatorProcess) => boolean,
  deadline: number
): Promise<EmulatorProcess[]> {
  for (;;) {
    const remaining = (await listEmulatorProcessesForAvd(avdName)).filter(filter);
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await new Promise((r) =>
      setTimeout(r, Math.min(BOOT_POLL_INTERVALS_MS.serialGone, deadline - Date.now()))
    );
  }
}

/**
 * Drop from `serialsBefore` the emulator serials adb still lists with nothing
 * behind them. After qemu exits, adb keeps the serial for up to a second, and
 * the next spawn takes the freed console port, so it would register under a
 * serial already counted as pre-existing. Only serials without a readable AVD
 * name are asked; the console refuses the connection at once when the port is
 * free. One that names another AVD, or does not answer (frozen, shutting down),
 * stays: it still holds its port. No waiting is involved.
 */
async function dropUnreachableSerials(
  devices: AndroidDevice[],
  serialsBefore: Set<string>
): Promise<void> {
  await Promise.all(
    devices
      .filter((d) => d.isEmulator && !(d.state === "device" && d.avdName !== null))
      .map(async (d) => {
        if ((await readEmulatorConsoleAvdName(d.serial)).status === "unreachable") {
          serialsBefore.delete(d.serial);
        }
      })
  );
}

/**
 * Pick ours among the serials new since the before-spawn snapshot. The console
 * names an emulator's AVD within milliseconds of the serial appearing, while
 * getprop still fails, and a serial that names another AVD is never ours: an
 * unrelated emulator killed and restarted at the same moment comes back on its
 * freed port, which the snapshot no longer holds. When no console names this
 * AVD, fall back to the before/after diff: a single unnamed serial is ours,
 * several are told apart by getprop.
 *
 * The AVD name alone does not settle it: read-only instances of one AVD run
 * side by side, so another one can register during this boot. So first the
 * process listening on each serial's console port is asked: a serial the
 * spawned emulator listens on is ours, one another process (or nothing)
 * listens on is not. When a probe fails this time, the pick waits for the next
 * poll rather than guess by name. Only where this host cannot read listeners at
 * all (Windows) do serials go through the name and getprop checks.
 */
async function pickOwnSerial(
  avdName: string,
  newSerials: string[],
  ownPid: number | undefined
): Promise<string | null> {
  let candidates = newSerials;
  if (ownPid !== undefined) {
    const owners = await Promise.all(newSerials.map((s) => consoleOwnership(s, ownPid)));
    const own = newSerials.find((_, i) => owners[i] === "own");
    if (own) return own;
    if (owners.includes("unknown")) return null;
    candidates = newSerials.filter((_, i) => owners[i] === "unavailable");
    if (candidates.length === 0) return null;
  }
  const names = await Promise.all(candidates.map((s) => readEmulatorConsoleAvdName(s)));
  const own = candidates.find((_, i) => {
    const answer = names[i]!;
    return answer.status === "ok" && answer.avdName === avdName;
  });
  if (own) return own;
  const unnamed = candidates.filter((_, i) => names[i]!.status !== "ok");
  if (unnamed.length === 0) return null;
  if (unnamed.length === 1) return unnamed[0]!;
  return findSerialByAvdName(avdName, unnamed, Date.now() + 3_000);
}

async function bootSimctl(
  prefix: string[],
  [sub, udid, ...rest]: ["shutdown" | "boot" | "bootstatus", string, ...string[]],
  timeoutMs: number
): Promise<void> {
  try {
    await execFileAsync("xcrun", [...prefix, sub, udid, ...rest], {
      timeout: timeoutMs,
      killSignal: SIMCTL_KILL_SIGNAL,
    });
  } catch (err) {
    if (!(err as { killed?: boolean }).killed) throw err;
    throw new FailureError(
      `simctl ${sub} of iOS simulator ${udid} did not finish within ${timeoutMs / 1000}s.`,
      {
        error_code: FAILURE_CODES.BOOT_IOS_SIMCTL_TIMEOUT,
        failure_stage: `boot_ios_simctl_${sub}`,
        failure_area: "tool_server",
        error_kind: "timeout",
        ...subprocessFailureMetadata(err, "xcrun_simctl"),
      },
      { cause: err as Error }
    );
  }
}

async function bootIos(
  udid: string,
  registry: Registry,
  force?: boolean,
  headless?: boolean,
  prepareOnly?: boolean
): Promise<IosBootResult | NativeDevtoolsInitFailedResult> {
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

  const scan = await scanIosSimulators().catch(() => undefined);
  const simMatch = scan?.simulators.find((s) => s.udid === udid);
  // Booting without the state would skip the pre-boot AX prefs below, leaving
  // describe degraded until the next reboot.
  if (!simMatch && scan?.timedOut) {
    throw new FailureError(
      `Could not read the state of iOS simulator ${udid}: ${simctlListTimeoutAdvice("boot-device")}`,
      {
        error_code: FAILURE_CODES.BOOT_IOS_SIMCTL_LIST_TIMEOUT,
        failure_stage: "boot_ios_state_probe",
        failure_area: "tool_server",
        error_kind: "timeout",
      }
    );
  }
  const simState = simMatch?.state;
  const isTvOs = simMatch?.runtimeKind === "tv";
  if (prepareOnly) {
    if (simState !== "Shutdown") {
      throw new InvalidToolInputError(
        `prepareOnly requires a Shutdown simulator. State of ${udid}: ${simState ?? "unknown"}.`
      );
    }
    await setAccessibilityPrefsPreBoot(udid, { isTvOs });
    return { platform: "ios", udid, booted: false, prepared: true };
  }
  // The scan above already learned which device set owns this UDID,
  // so this resolves from cache; every simctl below targets that set.
  const deviceSet = await deviceSetForUdid(udid);
  const prefix = simctlPrefix(deviceSet);

  // Booting: e.g. the boot of a call whose `simctl boot` timed out, which CoreSimulator still finishes.
  const booting = simState === "Booting";
  // force=true on a running sim: shut it down so we can pre-write AX prefs.
  // A booting one is waited for first, so the shutdown sees it Booted.
  if (force && booting) {
    await bootSimctl(prefix, ["bootstatus", udid, "-b"], 480_000);
  }
  if (force && (simState === "Booted" || booting)) {
    await bootSimctl(prefix, ["shutdown", udid], 30_000);
  }

  const needsPreBoot = simState === "Shutdown" || (force && (simState === "Booted" || booting));
  if (needsPreBoot) {
    await setAccessibilityPrefsPreBoot(udid, { isTvOs }).catch((err: unknown) => {
      process.stderr.write(
        `[boot-device ${udid.slice(0, 8)}] pre-boot AX pref write failed (${
          err instanceof Error ? err.message : String(err)
        }); describe may return an empty tree until a later boot writes them.\n`
      );
    });
  }

  await bootSimctl(prefix, ["boot", udid], 120_000).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // bootstatus below waits for a Booting one.
    if (!/Unable to boot device in current state: Boot(ed|ing)\b/.test(message)) {
      throw err;
    }
  });
  await bootSimctl(prefix, ["bootstatus", udid, "-b"], 480_000);

  // tvOS only: a boot transition orphans the host-side tvos-hid-daemon, which
  // holds a SimDeviceLegacyClient bound to the previous boot for its whole
  // lifetime (unlike the ax daemon, which runs inside the sim and is respawned).
  // The daemon survives the reboot with an invalid client and its sends are
  // fire-and-forget, so TV button presses silently no-op. Dropping the cached
  // TvControl service forces the next TV call to rebuild it against the new
  // boot. ServiceNotFoundError just means nothing was cached.
  if (isTvOs && (needsPreBoot || booting)) {
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

  if (isTvOs) await ensureAutomationEnabled(udid).catch(() => undefined);
  else await clearAutomationEnabledOrWarn(udid);

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
  let note: string | undefined;
  if (!headless && !iosHeadlessFromEnv() && !deviceSet) {
    // Best-effort: a missing GUI app never fails a boot whose core is already up.
    note = await openSimulatorWindow(udid).catch(() => undefined);
  }
  return { platform: "ios", udid, booted: true, ...(note ? { note } : {}) };
}

/**
 * Shows the booted device in the GUI app of the active Xcode (the one `xcrun`
 * resolves), never one found elsewhere on the host: `open -a Simulator.app`
 * alone would launch an older Xcode's Simulator.app on an Xcode 27 host.
 * Xcode 27 replaces Simulator.app with Device Hub, which opens the device's
 * own window from a `devices://device/open?id=<udid>` URL; it reports success
 * even when it cannot show the device, so a missing window goes unnoticed.
 * Without either app, or with a Simulator.app on record as crashing at launch,
 * nothing is opened. Returns a note once the Simulator.app is on record so,
 * including from the launch that records it.
 */
async function openSimulatorWindow(udid: string): Promise<string | undefined> {
  const timeout = 5_000;
  const { stdout } = await execFileAsync("xcode-select", ["-p"], { timeout });
  const developerDir = realpathSync(stdout.trim());
  const simulatorApp = join(developerDir, "Applications", "Simulator.app");
  if (existsSync(simulatorApp)) {
    const launched = await launchSimulatorApp(simulatorApp, () =>
      execFileAsync("open", ["-a", simulatorApp], { timeout })
    );
    return launched
      ? undefined
      : `${simulatorApp} exits right after launch on this host, so Argent no longer opens it and the device runs without a window. Delete ~/.argent/simulator-app-launch.json to try opening it again.`;
  }
  const deviceHubApp = join(developerDir, "..", "Applications", "DeviceHub.app");
  if (existsSync(deviceHubApp)) {
    const url = `devices://device/open?id=${encodeURIComponent(udid)}`;
    await execFileAsync("open", ["-a", deviceHubApp, url], { timeout });
  }
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

  const booting = simState === "Booting";
  // A booting one is waited for first, so the shutdown sees it Booted.
  if (force && booting) {
    await simRemoteBootstatus(id, { boot: true });
  }
  if (force && (simState === "Booted" || booting)) {
    await simRemoteShutdown(id).catch(() => undefined);
  }

  // A `Booted` or `Booting` error from sim-remote just means it is up or on its
  // way; bootstatus below waits for it either way.
  await simRemoteBoot(id).catch((err: Error) => {
    if (!/Booted|current state: Booting\b/i.test(err.message)) throw err;
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
function portInUseError(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.BOOT_ANDROID_PORT_IN_USE,
    failure_stage: "boot_android_port",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function isPortInUse(err: unknown): boolean {
  return getFailureSignal(err)?.error_code === FAILURE_CODES.BOOT_ANDROID_PORT_IN_USE;
}

/**
 * Whether the emulator on the pinned `serial` is the one `child` started:
 * "own", "none" while nothing this boot can tell holds the port, or the port
 * error when another emulator holds it.
 *
 * The console's AVD name is not enough: read-only instances of one AVD all
 * name it, and one that binds the pinned port first (a person following the
 * docs, another tool-server) would be taken for ours, then killed by serial
 * on a failure path. So the process listening on the console port decides
 * (see `consoleOwnership`). A probe that fails this time leaves the port
 * undecided ("none") while ours runs, so the next poll asks again. Only where
 * this host cannot read listeners at all (Windows) does the name decide, and
 * then an emulator of this AVD counts as ours only while ours has not exited
 * early. Once ours has exited, whatever answers on the port is not ours.
 */
async function pinnedPortHolder(
  serial: string,
  avdName: string,
  child: import("node:child_process").ChildProcess,
  exitedEarly: boolean
): Promise<"own" | "none"> {
  const owner = child.pid === undefined ? "unavailable" : await consoleOwnership(serial, child.pid);
  if (owner === "own") return "own";
  if (owner === "free") return "none";
  if (owner === "unknown" && !exitedEarly) return "none";
  const answer = await readEmulatorConsoleAvdName(serial);
  const holderAvd = answer.status === "ok" ? answer.avdName : undefined;
  if (owner === "other") throw portTakenError(serial, holderAvd);
  if (holderAvd === undefined) return "none";
  if (holderAvd !== avdName || exitedEarly) throw portTakenError(serial, holderAvd);
  return "own";
}

function portTakenError(serial: string, holderAvd: string | undefined): FailureError {
  const holder =
    holderAvd === undefined ? "another emulator" : `another emulator running AVD "${holderAvd}"`;
  return portInUseError(
    `Port ${serial.replace(/^emulator-/, "")} was taken by ${holder} (${serial}) while this ` +
      `boot started. Pick another \`port\`.`
  );
}

/** True when something accepts TCP connections on 127.0.0.1:`port`. */
function isLocalPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

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
  // The serial the emulator must register under: `emulator-<port>` when the
  // caller passed `-port`. Unset, ours is picked among the new serials.
  expectedSerial?: string;
  // Without `expectedSerial`: serials that are never ours, because another
  // boot pinned them with `-port`. Asked again on every poll.
  pinnedElsewhere?: () => Promise<Set<string>>;
}): Promise<{ serial: string; pid: number | undefined }> {
  // On Windows the emulator hangs mid-boot when spawned with stdio:"ignore" —
  // a detached process whose stdout/stderr are NUL never reaches
  // sys.boot_completed — so give it a per-AVD log file for valid write handles.
  // The name is fixed per AVD and truncated on open, so boots reuse one file
  // rather than littering temp. A writable AVD runs once at a time; read-only
  // instances share it, so each launch on its own port gets its own file. POSIX
  // keeps "ignore".
  let emulatorLogFd: number | undefined;
  let stdio: StdioOptions = "ignore";
  if (process.platform === "win32") {
    const portArg = params.emulatorArgs.indexOf("-port");
    const instance =
      portArg >= 0 ? `${params.avdName}-${params.emulatorArgs[portArg + 1]}` : params.avdName;
    const safeName = instance.replace(/[^\w.-]/g, "_");
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
      if (launchError) {
        // An emulator that exits on a pinned port usually lost the port to
        // another one that bound it after the pre-spawn check.
        if (params.expectedSerial !== undefined) {
          await pinnedPortHolder(params.expectedSerial, params.avdName, child, true);
        }
        throw launchError;
      }
      let newSerials = await listNewEmulatorSerials(params.serialsBefore);
      if (params.expectedSerial !== undefined) {
        // The serial alone does not make the emulator ours: another emulator,
        // of this AVD too, can bind the port first. Only ours is taken, so a
        // failure path never kills somebody else's emulator by serial.
        if (
          newSerials.includes(params.expectedSerial) &&
          (await pinnedPortHolder(params.expectedSerial, params.avdName, child, false)) === "own"
        ) {
          serial = params.expectedSerial;
          break;
        }
      } else if (newSerials.length >= 1) {
        if (params.pinnedElsewhere) {
          const pinned = await params.pinnedElsewhere();
          newSerials = newSerials.filter((s) => !pinned.has(s));
        }
        const own =
          newSerials.length > 0 ? await pickOwnSerial(params.avdName, newSerials, child.pid) : null;
        if (own) {
          serial = own;
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
    if (params.expectedSerial !== undefined) {
      await pinnedPortHolder(
        params.expectedSerial,
        params.avdName,
        child,
        readEarlyExitError() !== null
      ).catch((err: unknown) => {
        killDetachedEmulator(child);
        throw err;
      });
    }
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

  return { serial, pid: child.pid };
}

// In-flight boot per AVD instance. Two concurrent `bootAndroid` calls for the
// same instance would both pass the "already running" fast path (the emulator
// hasn't registered yet) and spawn QEMU twice; the second collides on the AVD's
// exclusive on-disk lock and bails with a confusing "Running multiple
// emulators". Coalescing makes the duplicate reuse the first result or error.
// The key carries the mode and port: a read-only instance holds no lock, so
// boots of one AVD on two ports are different emulators and must not share a
// result. Boots that cannot run side by side wait for each other instead; see
// bootAndroid.
// A default launch puts the gRPC server this far above the console port
// (5554 -> 8554).
const GRPC_PORT_OFFSET = 3000;

type InFlightBoot = {
  avdName: string;
  readOnly: boolean;
  port?: number;
  /** False while it waits for clashing boots ahead of it, before any spawn. */
  started: boolean;
  promise: Promise<AndroidBootResult>;
};

const inFlightBoots = new Map<string, InFlightBoot>();

type AndroidBootParams = {
  avdName: string;
  bootTimeoutMs: number;
  force?: boolean;
  sound: boolean;
  guestVulkan: boolean;
  readOnly: boolean;
  port?: number;
};

function inFlightBootKey(params: AndroidBootParams): string {
  return `${params.avdName}\u0000${params.readOnly ? "ro" : "rw"}\u0000${params.port ?? ""}`;
}

// Read-only emulators argent booted are recorded by serial and pid, also across
// tool-server restarts: see utils/android-read-only-boots.

/** What argent knows about the running instances of one AVD. */
type AvdInstances = {
  processes: EmulatorProcess[] | null;
  /** Serials of the read-only instances. */
  readOnly: Set<string>;
  /**
   * Serials pinned with `-port`, by anyone, plus the ports of pinned boots that
   * have started here (not those still queued). A call without `port` never
   * takes one of these.
   */
  pinned: Set<string>;
};

/**
 * Tell the running instances of `avdName` apart. The process table shows the
 * `-read-only` and `-port` flags; argent's own record covers instances launched
 * without `-port`. When the process table cannot be read (Windows, or `ps`
 * failed), argent's record is trusted while adb still lists the serial
 * (`listed`): the emulator may well still run, and dropping it would make the
 * next boot take a read-only instance for a writable one. A serial adb no
 * longer lists has no emulator behind it, so its record goes, and an emulator
 * that later comes up on that serial is not taken for the old one.
 */
async function avdInstances(avdName: string, listed?: Set<string>): Promise<AvdInstances> {
  const processes = await readEmulatorProcessesForAvd(avdName);
  const readOnly = new Set<string>();
  const pinned = new Set<string>();
  for (const b of inFlightBoots.values()) {
    if (b.port !== undefined && b.started) pinned.add(`emulator-${b.port}`);
  }
  for (const p of processes ?? []) {
    if (p.port === null) continue;
    pinned.add(`emulator-${p.port}`);
    if (p.readOnly) readOnly.add(`emulator-${p.port}`);
  }
  for (const boot of readOnlyBootEntries()) {
    const serial = boot.serial;
    if (boot.avdName !== avdName) continue;
    // A record an earlier tool-server left is believed only where the process
    // table confirms it: without one, its emulator may have exited between
    // the two tool-servers and another one taken the serial.
    if (processes === null && !boot.ownProcess) continue;
    const gone =
      processes !== null
        ? !processes.some((p) => p.pid === boot.pid && p.readOnly)
        : listed !== undefined && !listed.has(serial);
    if (gone) {
      forgetReadOnlyBoot(serial, boot.pid);
      continue;
    }
    readOnly.add(serial);
    if (boot.pinned) pinned.add(serial);
  }
  return { processes, readOnly, pinned };
}

/**
 * Clear the in-flight boot map. For tests that intentionally abandon a
 * half-started boot: the leaked promise would otherwise coalesce into the next
 * test targeting the same AVD and starve it of a real spawn.
 */
export function __resetInFlightBootsForTesting(): void {
  inFlightBoots.clear();
  __clearReadOnlyBootsForTesting();
}

/**
 * Whether two boots must not run at the same time. The emulator runs one AVD
 * writable once, or read-only any number of times, so any pair with a writable
 * boot of the same AVD clashes; checked one after the other, the second sees
 * the first's emulator and reports the conflict, while checked together both
 * pass and the later spawn exits as if the AVD were corrupted. Two boots that
 * pin the same port clash too, whatever their AVD.
 */
function bootsClash(
  a: { avdName: string; readOnly: boolean; port?: number },
  b: { avdName: string; readOnly: boolean; port?: number }
): boolean {
  if (a.port !== undefined && a.port === b.port) return true;
  return a.avdName === b.avdName && !(a.readOnly && b.readOnly);
}

/**
 * The running instances of `avdName` matching `filter`, leaving out the one
 * behind `serial`. One launched with `-port` shows its serial's port in the
 * process table. One launched without it is told by the pid argent recorded
 * for it, or else by which process listens on the serial's console port. A
 * portless process that cannot be told either way is left out: it may be the
 * one behind `serial`. Empty when the process table cannot be read.
 */
async function blockersBesides(
  avdName: string,
  serial: string,
  filter: (p: EmulatorProcess) => boolean
): Promise<EmulatorProcess[]> {
  const processes = await readEmulatorProcessesForAvd(avdName);
  if (processes === null) return [];
  const port = Number(serial.match(/^emulator-(\d+)$/)?.[1]);
  const record = readOnlyBootEntries().find((b) => b.serial === serial);
  const knownPid =
    record?.avdName === avdName && processes.some((p) => p.pid === record.pid)
      ? record.pid
      : undefined;
  const others: EmulatorProcess[] = [];
  for (const p of processes.filter(filter)) {
    if (p.port !== null) {
      if (p.port !== port) others.push(p);
    } else if (knownPid !== undefined) {
      if (p.pid !== knownPid) others.push(p);
    } else if (["other", "free"].includes(await consoleOwnership(serial, p.pid))) {
      others.push(p);
    }
  }
  return others;
}

/**
 * What a writable boot blocked by a writable instance can do. A boot with
 * `port` was refused because the instance runs elsewhere, so the call that
 * reaches it is named. A boot without `port` already takes any writable
 * instance, so this one was not ready to reuse (for example frozen), and only
 * closing it helps.
 */
function writableConflictAdvice(
  params: AndroidBootParams,
  writable: EmulatorProcess[],
  shutDown: boolean
): string {
  if (params.port === undefined) {
    return shutDown
      ? `This call shut that emulator down, and it has not exited yet. Retry once it exits.`
      : `That emulator did not become ready to reuse. Close it, then retry.`;
  }
  const ports = [...new Set(writable.flatMap((p) => (p.port !== null ? [p.port] : [])))];
  const reach =
    ports.length === 1 && writable.every((p) => p.port !== null)
      ? `Boot without \`port\`, or with \`port: ${ports[0]}\`, to use it`
      : `Boot without \`port\` to use it`;
  return `${reach}, or close it, then retry.`;
}

/** The emulator refuses to start this boot next to the `blocking` instances. */
function readOnlyConflictError(
  params: AndroidBootParams,
  blocking: EmulatorProcess[],
  shutDown = false
): FailureError {
  const describe = (p: EmulatorProcess) =>
    `pid ${p.pid}${p.port !== null ? ` on emulator-${p.port}` : ""}`;
  const writable = blocking.filter((p) => !p.readOnly);
  const message = params.readOnly
    ? `AVD "${params.avdName}" is running writable (${writable.map(describe).join(", ")}), and ` +
      `the emulator starts a read-only instance only next to other read-only ones. Close that ` +
      `emulator, or start it with \`-read-only\` too, then retry.`
    : writable.length > 0
      ? `AVD "${params.avdName}" is already running writable (${writable.map(describe).join(", ")}), ` +
        `and the emulator runs one writable instance of an AVD at a time. ` +
        writableConflictAdvice(params, writable, shutDown)
      : `AVD "${params.avdName}" is running read-only (${blocking.map(describe).join(", ")}), and ` +
        `the emulator cannot start a writable instance next to it. Pass \`readOnly: true\`, or ` +
        `close the read-only emulators, then retry.`;
  return new FailureError(message, {
    error_code: FAILURE_CODES.BOOT_ANDROID_READ_ONLY_CONFLICT,
    failure_stage: "boot_android_read_only",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * Start an Android boot, or join the one in flight for the same instance. A
 * boot that clashes with boots already in flight or queued (see
 * `bootsClash`) waits for them first. It waits only for those that came before
 * it: any clashing boot that comes later waits for this one, so a queued boot
 * is not overtaken. The wait counts against `bootTimeoutMs`.
 */
async function bootAndroid(params: AndroidBootParams): Promise<AndroidBootResult> {
  const key = inFlightBootKey(params);
  const existing = inFlightBoots.get(key);
  if (existing) return existing.promise;
  const deadline = Date.now() + params.bootTimeoutMs;
  const ahead = [...inFlightBoots.values()].filter((b) => bootsClash(b, params));
  const entry: Omit<InFlightBoot, "promise"> & { promise?: Promise<AndroidBootResult> } = {
    avdName: params.avdName,
    readOnly: params.readOnly,
    ...(params.port !== undefined ? { port: params.port } : {}),
    started: ahead.length === 0,
  };
  const promise = (async () => {
    if (ahead.length > 0) {
      await waitForBootsAhead(params, ahead, deadline);
      entry.started = true;
    }
    return bootAndroidImpl(params, deadline);
  })().finally(() => {
    inFlightBoots.delete(key);
  });
  entry.promise = promise;
  inFlightBoots.set(key, entry as InFlightBoot);
  return promise;
}

/** Wait for the clashing boots `ahead` to settle, or fail once `deadline` passes. */
async function waitForBootsAhead(
  params: AndroidBootParams,
  ahead: InFlightBoot[],
  deadline: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(ahead.map((b) => b.promise)).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    }),
  ]);
  clearTimeout(timer);
  if (settled) return;
  const samePort = params.port !== undefined && ahead.some((b) => b.port === params.port);
  const which = samePort
    ? `another boot on port ${params.port}`
    : `another boot of AVD "${params.avdName}" that cannot run next to this one`;
  throw new FailureError(
    `This boot waited for ${which}, and it did not finish within ` +
      `${Math.round(params.bootTimeoutMs / 1000)}s (\`bootTimeoutMs\`). Retry once it finishes.`,
    {
      error_code: samePort
        ? FAILURE_CODES.BOOT_ANDROID_PORT_IN_USE
        : FAILURE_CODES.BOOT_ANDROID_READ_ONLY_CONFLICT,
      failure_stage: "boot_android_queue",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

async function bootAndroidImpl(
  params: AndroidBootParams,
  overallDeadline: number
): Promise<AndroidBootResult> {
  // Preflight both Android binaries up front so a missing emulator package
  // surfaces as an install hint, not a misleading "no AVDs" from `listAvds()`.
  // `ensureDep` resolves through `$ANDROID_HOME` as well as PATH.
  await ensureDep("adb");
  await ensureDep("emulator");
  // Validate boot-configuration env vars before any slow I/O so a typo in
  // ARGENT_EMULATOR_GPU_MODE surfaces immediately rather than mid-boot with a
  // misleading "emulator has been terminated" suffix.
  const gpuMode = selectGpuMode();
  // Opt-in headless mode via ARGENT_EMULATOR_NO_WINDOW (see no-window-env.ts),
  // and the macOS guest Vulkan choice.
  const extraEmulatorArgs = [
    ...(androidHeadlessFromEnv() ? ["-no-window"] : []),
    ...guestVulkanArgs(params.guestVulkan),
  ];
  const hardeningArgs = launchHardeningArgs(params.sound);
  // `-read-only` lets several emulators share the AVD: it takes no AVD lock and
  // writes no snapshot. `-port` pins the console port, so the serial is known
  // before the spawn. With `-port` the emulator starts no gRPC server and writes
  // no `avd/running/pid_<pid>.ini`, and simulator-server finds the emulator
  // through that file, so screenshots and gestures fail. `-grpc` on the port a
  // default launch would take (console + 3000) with `-grpc-use-token` brings
  // both back, with the same local-only, token-checked server. None of these
  // changes qemu devices, so a snapshot probe and a hot boot with them still
  // match the snapshot a writable cold boot saved.
  const grpcPort = params.port !== undefined ? params.port + GRPC_PORT_OFFSET : null;
  const instanceArgs = [
    ...(params.readOnly ? ["-read-only"] : []),
    ...(params.port !== undefined
      ? ["-port", String(params.port), "-grpc", String(grpcPort), "-grpc-use-token"]
      : []),
  ];
  const portSerial = params.port !== undefined ? `emulator-${params.port}` : null;

  for (const msg of linuxBootDiagnostics(params.avdName) ?? []) {
    console.warn(`[boot-device:linux] ${msg}`);
  }
  const emulatorBinary = await resolveEmulatorOrThrow();
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
  let listed = true;
  const existingDevices = await listAndroidDevices().catch(() => {
    listed = false;
    return [];
  });

  // This AVD may be alive without being healthy in adb (killed outside argent
  // and shutting down, or still coming up). Wait for its process to exit or for
  // it to become reusable, within the boot budget; see awaitOwnEmulatorSettled.
  // A read-only boot skips the wait: another read-only instance coming up does
  // not get in its way, and a writable one is refused below whatever its state.
  if (!params.readOnly && !existingDevices.some((d) => isRunningAvd(d, params.avdName))) {
    const settled = await awaitOwnEmulatorSettled(
      params.avdName,
      Math.min(overallDeadline, Date.now() + EMULATOR_GONE_BUDGET_MS)
    );
    if (settled) existingDevices.splice(0, existingDevices.length, ...settled);
  }

  // Fast path: reuse this AVD when it is already running and ready, instead of
  // spawning a second emulator that collides on AVD locks and fails with a
  // misleading "Running multiple emulators" error.
  let hotBootFailureReason: string | null;
  const dropKilledEmulator = async (serial: string) => {
    forgetReadOnlyBoot(serial);
    await awaitEmulatorsGone([serial]);
    const refreshed = await listAndroidDevices().catch(() => existingDevices);
    existingDevices.splice(0, existingDevices.length, ...refreshed);
  };
  // Which running instance is this boot's. With a port, only the emulator on
  // it. Without one, never a read-only instance pinned with `-port`: that
  // belongs to the calls that name its port, typically another agent's. A
  // writable instance is taken even when pinned: the AVD runs one writable
  // instance at a time, so a writable boot could do nothing else, and a
  // read-only boot is refused next to it below. A read-only boot takes only a
  // read-only instance, never a writable one, which would be someone's own
  // emulator holding the AVD. A writable boot takes any, preferring a writable
  // one: the emulator refuses to start a writable instance next to a read-only
  // one anyway.
  const instances = await avdInstances(
    params.avdName,
    listed ? new Set(existingDevices.map((d) => d.serial)) : undefined
  );
  const candidates = existingDevices.filter(
    (d) =>
      isRunningAvd(d, params.avdName) &&
      (portSerial !== null
        ? d.serial === portSerial
        : !instances.pinned.has(d.serial) ||
          (!params.readOnly && !instances.readOnly.has(d.serial)))
  );
  // The instances that keep this boot from spawning: for a read-only boot a
  // writable one, for a writable boot any.
  const blocks = (p: EmulatorProcess) => !params.readOnly || !p.readOnly;
  let alreadyRunning = params.readOnly
    ? candidates.find((d) => instances.readOnly.has(d.serial))
    : (candidates.find((d) => !instances.readOnly.has(d.serial)) ?? candidates[0]);
  let preserveOnProbeFailure = false;
  if (params.readOnly && !alreadyRunning && candidates[0]) {
    // A running instance of this AVD that argent does not recognise as
    // read-only: launched without `-port` by someone else, on the requested
    // port or, for a boot without one, anywhere unpinned. With no writable
    // instance of the AVD in the process table it is read-only. With no
    // process of the AVD found at all, the table does not show how it was
    // launched, so it cannot tell. A boot without `port` then goes on below:
    // refused next to a writable instance, else starting its own.
    const { processes } = instances;
    const known = processes !== null && processes.length > 0;
    if (known && processes.every((p) => p.readOnly)) {
      alreadyRunning = candidates[0];
      preserveOnProbeFailure = portSerial === null;
    } else if (portSerial !== null && !params.force) {
      throw portInUseError(
        known
          ? `${portSerial} already runs AVD "${params.avdName}" writable. Pass \`force: true\` to ` +
              `shut it down and boot it read-only, or pick another \`port\`.`
          : `${portSerial} already runs AVD "${params.avdName}", and Argent cannot tell whether it ` +
              `runs read-only: ${processes === null ? "the process list of this host is not available" : "its process is not in the process list"}. ` +
              `Use that emulator as it is, or pick another \`port\`.`
      );
    } else if (portSerial !== null) {
      alreadyRunning = candidates[0];
    }
  }
  let killedRunning = false;
  if (alreadyRunning) {
    if (params.force) {
      // Shutting it down only helps when nothing else blocks the boot: another
      // instance would leave the call failing with this emulator gone, though
      // other agents may still have been using it.
      const others = await blockersBesides(params.avdName, alreadyRunning.serial, blocks);
      if (others.length > 0) throw readOnlyConflictError(params, others);
      await killEmulatorQuietly(alreadyRunning.serial);
      await dropKilledEmulator(alreadyRunning.serial);
      killedRunning = true;
    } else {
      // A long-running emulator can drift into the same sticky-blank
      // SurfaceFlinger state `assertScreencapAlive` guards against on hot boot:
      // readiness probes pass but every screenshot is black. Reusing an
      // external unpinned emulator does not authorize replacing it.
      try {
        await assertScreencapAlive(
          alreadyRunning.serial,
          preserveOnProbeFailure ? "preserve" : "replace"
        );
        const note = await runningGuestVulkanNote(alreadyRunning.serial, params.guestVulkan);
        return {
          platform: "android",
          serial: alreadyRunning.serial,
          avdName: params.avdName,
          booted: true,
          ...(note ? { note } : {}),
        };
      } catch (err) {
        if (preserveOnProbeFailure) throw err;
        // assertScreencapAlive already killed the emulator.
        await dropKilledEmulator(alreadyRunning.serial);
      }
    }
  }
  // The emulator runs one AVD either writable once or read-only any number of
  // times, never both: it refuses the spawn with an early exit argent would
  // otherwise report as a corrupted AVD. Name the instance in the way instead.
  // A read-only boot is blocked by a writable instance; a writable boot by any
  // instance it did not reuse, writable on another port included. One this call
  // just shut down may take a moment to leave the process table.
  const blocking = await awaitEmulatorProcessesGone(
    params.avdName,
    blocks,
    killedRunning ? Math.min(overallDeadline, Date.now() + EMULATOR_GONE_BUDGET_MS) : 0
  );
  if (blocking.length > 0) throw readOnlyConflictError(params, blocking, killedRunning);

  const serialsBefore = new Set(existingDevices.map((d) => d.serial));
  await dropUnreachableSerials(existingDevices, serialsBefore);
  if (portSerial !== null) {
    // The port must be free: any emulator still listed on it whose console
    // answers holds it (another AVD, or this one shutting down or coming up).
    // One whose console refuses is gone and only lingers in adb.
    if (serialsBefore.has(portSerial)) {
      const answer = await readEmulatorConsoleAvdName(portSerial);
      if (answer.status !== "unreachable") {
        const holder =
          answer.status === "ok" ? `an emulator running AVD "${answer.avdName}"` : "an emulator";
        throw portInUseError(
          `Port ${params.port} is in use by ${holder} (${portSerial}). ` +
            `Pick another \`port\`, or wait for that emulator to finish starting or shutting down.`
        );
      }
    }
    // The emulator needs the gRPC port next to the console port; taken, it
    // starts without the server and simulator-server cannot reach it.
    if (grpcPort !== null && (await isLocalPortListening(grpcPort))) {
      throw portInUseError(
        `Port ${grpcPort}, the gRPC port of console port ${params.port}, is in use. ` +
          `Pick another \`port\`.`
      );
    }
    serialsBefore.delete(portSerial);
  }
  const expectedSerial = portSerial ?? undefined;
  const pinnedElsewhere =
    portSerial === null ? async () => (await avdInstances(params.avdName)).pinned : undefined;
  // A boot's emulator replaces any record of an earlier one on its serial: a
  // writable boot that comes up there is not the read-only one that left.
  const rememberReadOnly = (serial: string, pid: number | undefined) => {
    if (params.readOnly && pid !== undefined) {
      rememberReadOnlyBoot(serial, { avdName: params.avdName, pid, pinned: portSerial !== null });
    } else {
      forgetReadOnlyBoot(serial);
    }
  };

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
      extraArgs: [...RENDERER_ARGS, ...hardeningArgs, ...crashReportArgs, ...instanceArgs],
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
        ...instanceArgs,
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
          expectedSerial,
          pinnedElsewhere,
        });
        await assertScreencapAlive(result.serial, "replace");
        rememberReadOnly(result.serial, result.pid);
        return {
          platform: "android",
          serial: result.serial,
          avdName: params.avdName,
          booted: true,
        };
      } catch (err) {
        // Another emulator took the pinned port: a cold boot would only lose it again.
        if (isPortInUse(err)) throw err;
        hotBootFailureReason = err instanceof Error ? err.message : String(err);
        // attemptBoot already killed the failed child. A serial still listed
        // past the wait is a zombie the cold boot must not take for its own.
        await awaitEmulatorsGone(await listNewEmulatorSerials(serialsBefore));
        const refreshed = new Set(
          (await listAndroidDevices().catch(() => [])).map((d) => d.serial)
        );
        for (const s of refreshed) serialsBefore.add(s);
        // The failed child held the requested port; the cold boot takes it next.
        if (portSerial !== null) serialsBefore.delete(portSerial);
      }
    }
  }

  // Cold boot fallback (either no usable snapshot, or hot-boot attempt failed).
  // Renderer args mirror the hot-boot path so the snapshot this cold boot
  // saves matches the renderer the next launch's probe will resolve.
  // hardeningArgs likewise — `-noaudio` and `-netfast` change device topology,
  // so a mismatch between cold-save and hot-load would invalidate the saved
  // snapshot. crashReportArgs rides along from the same detection. A read-only
  // cold boot saves no snapshot: `-no-snapshot-save` states it rather than
  // leaving it to `-read-only`, so the AVD's quickboot snapshot, which a human
  // may be booting from right now, is never rewritten.
  const coldArgs = [
    "-avd",
    params.avdName,
    "-no-snapshot-load",
    ...(params.readOnly ? ["-no-snapshot-save"] : []),
    "-gpu",
    gpuMode,
    ...extraEmulatorArgs,
    ...hardeningArgs,
    ...crashReportArgs,
    ...instanceArgs,
  ];
  let coldResult: { serial: string; pid: number | undefined };
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
      expectedSerial,
      pinnedElsewhere,
    });
  } catch (err) {
    if (isPortInUse(err)) throw err;
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
  rememberReadOnly(coldResult.serial, coldResult.pid);

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

/** `udid` is the connect-key id once the instance reached `hdc`, else the instance id. */
type HarmonyBootResult = {
  platform: "harmony";
  udid: string;
  instanceName: string;
  booted: true;
  note?: string;
};

// One in-flight boot per instance, as `inFlightVegaBoots`; `force` tells a
// boot that can be shared from one that must queue.
const inFlightHarmonyBoots = new Map<
  string,
  { force: boolean; promise: Promise<HarmonyBootResult> }
>();

/** Also spans a `force` shutdown, which runs on unpredictably after `-stop` returns. */
const HARMONY_BOOT_TIMEOUT_MS = 180_000;

/** Each poll spawns `hdc`, far dearer than an adb poll. */
const HARMONY_TARGET_POLL_MS = 2_000;

/** Only outlasts process startup: a failing `-start` prints and exits at once. */
const HARMONY_NO_HDC_GRACE_MS = 3_000;

/** How long a spent start-attempt log may keep occupying tmpdir before a sweep. */
const HARMONY_LOG_TTL_MS = 24 * 60 * 60 * 1_000;

const HARMONY_EXIT_POLL_MS = 50;

/** The manager reports only the symptom: a missing instance or image. */
const HARMONY_IMAGE_RESTRICTION =
  "Huawei serves HarmonyOS emulator images only within mainland China; outside it no image can " +
  "be downloaded, so no instance can be created and none can be started. argent cannot supply " +
  "the image; an instance has to be created in DevEco Studio on a host that can download one.";

/** A failed `-list` is also empty, so the restriction is offered, not asserted. */
const HARMONY_NO_INSTANCES =
  "The emulator manager listed no HarmonyOS instances — either none has been created, or the " +
  "listing itself failed; `Emulator -list -details` shows which. Create one in DevEco Studio if " +
  "there is none. If creating one fails for want of an image, note that Huawei serves HarmonyOS " +
  "emulator images only within mainland China.";

const HARMONY_ALREADY_RUNNING =
  "The instance was already running, so argent did not restart it — and an instance argent did " +
  "not start cannot be matched to the `hdc` connect key it registered under. Take the connect " +
  'key from `list-devices` (the `kind: "device"` entry), or re-run with `force: true` to ' +
  "restart the instance and have its key resolved here.";

const HARMONY_NO_TARGET =
  "The instance started but had not registered with `hdc` before the boot budget ran out, so " +
  "this payload names the instance rather than a connect key. It keeps booting: call " +
  '`list-devices` once it finishes and drive the `kind: "device"` entry that appears.';

const HARMONY_AMBIGUOUS_TARGET =
  "More than one `hdc` target registered while the instance was booting, so argent could not " +
  "tell which is the instance it started and did not guess. Call `list-devices` and drive the " +
  '`kind: "device"` entry for the instance, or stop the other emulator and re-run.';

const HARMONY_MISMATCHED_TARGET =
  "A target registered while the instance was booting, but its display is not the panel this " +
  "instance is configured with, so it is another device rather than the one argent started. " +
  'Call `list-devices` and drive the `kind: "device"` entry for the instance once it appears.';

const HARMONY_UNPROBEABLE_TARGET =
  "A target registered while the instance was booting but never reported a display argent could " +
  "read, so it could not tell whether the target is this instance or another device that " +
  "reconnected, and did not guess. A guest that has not finished compositing reads this way too, " +
  'so call `list-devices` once it finishes booting and drive the `kind: "device"` entry for ' +
  "the instance.";

const HARMONY_UNCONFIRMED_TARGET =
  "argent had no panel on record for this instance, so it could not check the target it returned " +
  "against one and matched on arrival timing alone. If another emulator or device reconnected " +
  "while the instance was booting, this may be its connect key; confirm against `list-devices` " +
  "before relying on it.";

const HARMONY_NOT_DRIVABLE =
  "The instance registered with `hdc` but had not answered `uitest` before the boot budget " +
  "ran out, so `describe`, `screenshot` and the gesture tools may fail for a little longer. " +
  "Retry the first interaction.";

const HARMONY_UNLISTABLE_TARGETS =
  "`hdc list targets` failed every time argent asked while the instance was booting, so it could " +
  "not tell whether the instance registered — this says nothing about the instance itself. Check " +
  "that `hdc` works (`hdc list targets`), then call `list-devices` and drive the " +
  '`kind: "device"` entry for the instance.';

const HARMONY_UNATTEMPTED_LISTING =
  "The boot budget ran out before argent could ask `hdc list targets` once while the instance " +
  "was coming up, so whether the instance registered was never checked — this says nothing " +
  'about `hdc` itself. Call `list-devices` and drive the `kind: "device"` entry for the ' +
  "instance once it appears.";

const HARMONY_NO_HDC =
  "The instance started, but `hdc` was not found, so argent cannot tell which target it " +
  "registered as and no interaction tool can reach it. Install DevEco Studio's device " +
  "connector (or put `hdc` on PATH), then call `list-devices`.";

/**
 * Strict listing: `hdc` exits 0 on its own failures, and an unreadable table
 * must not read as "nothing registered". `ok` is false only if every poll failed.
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
 * Keys `Connected` before the start. Not every listed key: a stopped instance
 * leaves an `Offline` row that it re-registers on, so it could never arrive.
 * Strict, because an empty baseline would make every connected emulator an
 * arrival; retried once, as the daemon restarting after `-stop` clears.
 */
async function connectedHarmonyKeys(
  stoppedInstance: string | null,
  deadline: number
): Promise<Set<string>> {
  for (let attempt = 0; ; attempt++) {
    // Spent from the boot budget: a `force` shutdown often leaves none.
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
            // `runHdc` already classified a timeout; keep its kind.
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

/** The guest reports its panel as oriented, the manager as configured. */
function sameHarmonyPanel(
  a: { width: number; height: number },
  b: { width: number; height: number }
): boolean {
  return (
    Math.min(a.width, a.height) === Math.min(b.width, b.height) &&
    Math.max(a.width, a.height) === Math.max(b.width, b.height)
  );
}

/** A `USB` target is a handset; an emulator is reached over TCP loopback. */
function couldBeHarmonyEmulator(target: { connection: string | null }): boolean {
  return target.connection !== "USB";
}

/**
 * `Emulator -start` is the emulator's supervisor and runs for its whole
 * lifetime, so it is spawned detached, logging to a file for diagnosis.
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
  // Unique per attempt: two tool-servers can boot one instance, and a shared
  // log would be truncated by the loser. Day-old logs are swept.
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith("argent-harmony-") || !entry.endsWith(".log")) continue;
      try {
        if (Date.now() - statSync(join(tmpdir(), entry)).mtimeMs > HARMONY_LOG_TTL_MS) {
          rmSync(join(tmpdir(), entry), { force: true });
        }
      } catch {
        // best-effort
      }
    }
  } catch {
    // the guarded open below handles an unreadable tmpdir
  }
  const safeName = instanceName.replace(/[^\w.-]/g, (c) => `%${c.codePointAt(0)!.toString(16)}`);
  const logPath = join(tmpdir(), `argent-harmony-${safeName}-${process.hrtime.bigint()}.log`);
  // Without a writable tmpdir the boot proceeds with no log.
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
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // best-effort
    }
  }

  let exit: { reason: string; output: string } | null = null;
  const record = (reason: string) => {
    if (exit) return;
    let output = "";
    try {
      output = readFileSync(logPath, "utf8");
    } catch {
      // no log; the reason alone carries it
    }
    exit = { reason, output };
  };
  child.on("exit", (code, signal) =>
    record(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)
  );
  // An unhandled async spawn `error` would crash the tool-server.
  child.on("error", (err) => record(`could not be spawned: ${err.message}`));

  return { exited: () => exit };
}

/** Keyed by the whole `reason` union so a new reason must be worded here. */
const HARMONY_NO_KEY_CAVEAT: Record<NonNullable<HarmonyTargetOutcome["reason"]>, string> = {
  ambiguous: HARMONY_AMBIGUOUS_TARGET,
  mismatched: HARMONY_MISMATCHED_TARGET,
  unprobeable: HARMONY_UNPROBEABLE_TARGET,
  unlistable: HARMONY_UNLISTABLE_TARGETS,
  unattempted: HARMONY_UNATTEMPTED_LISTING,
  none: HARMONY_NO_TARGET,
};

type HarmonyTargetOutcome = {
  key: string | null;
  unconfirmed?: boolean;
  reason?: "ambiguous" | "mismatched" | "unprobeable" | "unlistable" | "unattempted" | "none";
};

/**
 * `start()`, or null once `deadline` passes: each probe has a fixed timeout, so
 * a poll over several arrivals would otherwise overrun `bootTimeoutMs`. A thunk,
 * so nothing is spawned past the deadline.
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
 * The connect key of the one target that arrives after the start, or null.
 * Arrival is the only join between the manager and `hdc`. USB arrivals are
 * excluded, a candidate must report the instance's configured panel
 * (`expected`; null skips the check and marks the key `unconfirmed`), and two
 * confirmed arrivals are refused. A mismatched or unreadable panel is re-checked
 * every poll, since a booting foldable's panel is not settled.
 *
 * Not covered: two instances of one device profile, or another emulator started
 * outside this call during the window.
 */
async function waitForHarmonyTarget(
  before: Set<string>,
  deadline: number,
  checkAlive: () => void,
  expected: { width: number; height: number } | null
): Promise<HarmonyTargetOutcome> {
  let sawMismatch = false;
  let sawUnprobeable = false;
  // Never asking (a `force` shutdown spent the budget) is not a broken `hdc`.
  let listedOnce = false;
  let asked = false;
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
    // Bounded, not abandoned: a listing landing at the deadline still names the key.
    const budget = deadline - Date.now();
    if (budget <= 0) {
      // Catches an emulator that died in the final interval.
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
      // `0x0` is a guest not yet composited; a budget-cut probe lands here too.
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
    // Refused now: polling on would turn the refusal into a guess once one flaps.
    if (confirmed.length > 1) return { key: null, reason: "ambiguous" };
    checkAlive();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { key: null, reason: noKeyReason() };
    }
    await new Promise((r) => setTimeout(r, Math.min(HARMONY_TARGET_POLL_MS, remaining)));
  }
}

/**
 * Whether the guest answered `uitest dumpLayout` in time: `Connected` comes
 * before the window service, which fails dumps for a while after.
 */
async function waitForHarmonyDrivable(
  connectKey: string,
  deadline: number,
  checkAlive: () => void
): Promise<boolean> {
  const probePath = join(tmpdir(), `argent-harmony-bootprobe-${process.hrtime.bigint()}.json`);
  let inFlight: Promise<unknown> | null = null;
  try {
    for (;;) {
      const budget = deadline - Date.now();
      if (budget <= 0) {
        checkAlive();
        return false;
      }
      // An abandoned probe holds the device's `uitest` queue until killed.
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
    // An abandoned probe may still write the dump; remove it once it settles.
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
 * Whether the manager stopped reporting the instance as running. `-stop`
 * returns before the process is gone, and the `hdc` endpoint dies first.
 */
async function waitForHarmonyInstanceStopped(name: string, deadline: number): Promise<boolean> {
  for (;;) {
    const budget = deadline - Date.now();
    if (budget <= 0) return false;
    const instances = await listHarmonyInstances(Math.min(HARMONY_LIST_TIMEOUT_MS, budget)).catch(
      () => null
    );
    // A failed `-list` resolves `[]`, while a stopped instance is still a row.
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

  // `null` (the listing failed) neither blocks the start nor explains its failure.
  const instances = await listHarmonyInstances(
    Math.min(HARMONY_LIST_TIMEOUT_MS, Math.max(1, bootDeadline - Date.now()))
  ).catch(() => null);
  // Refuse an unknown name, as Android does. Only a listing with rows can: a
  // failed `-list` also resolves `[]`.
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
    // `-stop`'s own 30s ceiling can be a whole minimum budget.
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

  // Without a connector there is no target list to wait on; checked before the
  // snapshot, which reads that list.
  const hdcAvailable = Boolean(await resolveHdc());

  // Keys connected now belong to other devices; reaching `Connected` after this
  // marks the instance, even on the key it held before. `alreadyRunning` here
  // means this call stopped the instance.
  const before = hdcAvailable
    ? await connectedHarmonyKeys(alreadyRunning ? params.instanceName : null, bootDeadline)
    : new Set<string>();
  // Separates the instance reconnecting from another device doing the same.
  const expectedPanel = instances?.find((i) => i.name === params.instanceName)?.display ?? null;

  const emulator = await startHarmonyEmulator(params.instanceName);

  // Lets a death in the readiness wait say it came after registration.
  let resolvedKey: string | null = null;
  const assertEmulatorAlive = () => {
    {
      const exit = emulator.exited();
      if (!exit) return;
      // The exit code is no verdict; only the printed diagnostic is (see `harmony-cli.ts`).
      const diagnostic = emulatorFailure({ stdout: exit.output, stderr: "" });
      if (!diagnostic) {
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
      // Only the manager's own words justify blaming the region.
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

  // Without a connector, still watch the manager briefly so a failing start is
  // not reported `booted: true`. A single check would run before the child could
  // exit.
  if (!hdcAvailable) {
    const grace = Math.min(HARMONY_NO_HDC_GRACE_MS, Math.max(0, bootDeadline - Date.now()));
    if (grace > 0) await waitForHarmonyExit(emulator, grace);
    assertEmulatorAlive();
  }

  const outcome: HarmonyTargetOutcome = hdcAvailable
    ? await waitForHarmonyTarget(before, bootDeadline, assertEmulatorAlive, expectedPanel)
    : { key: null };
  const connectKey = outcome.key;

  // Registered is not drivable.
  resolvedKey = connectKey;
  const drivable = connectKey
    ? await waitForHarmonyDrivable(connectKey, bootDeadline, assertEmulatorAlive)
    : false;

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
  // `harmonyInstance` carries no `udid`, so the HTTP capability gate never sees it.
  assertHarmonyEnabled();
  // Same-`force` boots share one run; opposite ones serialize, or both reach
  // `-start` and the instance starts twice.
  const key = params.instanceName;
  const force = Boolean(params.force);
  const existing = inFlightHarmonyBoots.get(key);
  if (existing && existing.force === force) return existing.promise;
  const tracked = (async () => {
    if (existing) {
      try {
        await existing.promise;
      } catch {
        // the prior attempt failed; this one reports for itself
      }
    }
    return bootHarmonyImpl(params);
  })().finally(() => {
    if (inFlightHarmonyBoots.get(key)?.promise === tracked) inFlightHarmonyBoots.delete(key);
  });
  inFlightHarmonyBoots.set(key, { force, promise: tracked });
  return tracked;
}

/** The capability gate admits these ids for the other parameters, so they can arrive as a `udid`. */
const NON_IOS_UDID_HINT: Record<"android" | "chromium" | "vega", string> = {
  android: "Boot an Android emulator by passing `avdName` (an AVD name from `list-devices`).",
  chromium:
    "A Chromium app listed by `list-devices` is already running and needs no boot; to start an Electron app, pass `electronAppPath`.",
  vega: "Boot a Vega (Fire TV) Virtual Device by passing `vvdImage`.",
};

/**
 * `classifyDevice` calls every unrecognised id `android`; only an `emulator-`
 * serial is known to be one. Off macOS, `undefined` leaves `bootIos` to say
 * that no simulator can boot there.
 */
function nonIosUdidHint(
  udid: string,
  platform: "android" | "chromium" | "vega"
): string | undefined {
  if (platform !== "android" || isAndroidEmulatorSerial(udid)) return NON_IOS_UDID_HINT[platform];
  if (process.platform !== "darwin") return undefined;
  return (
    "Copy it exactly. " +
    "An Android emulator boots through `avdName`; a connected Android phone needs no boot."
  );
}

/**
 * Why `port` cannot be an emulator console port, or `undefined` when it can.
 * The emulator's own range for `-port` is 5554-5584, which is also the range
 * adb scans: an emulator above 5584 drops out of adb when the adb server
 * restarts. The console port is even; the adb port is the next odd one.
 */
function androidPortError(port: number): string | undefined {
  if (Number.isInteger(port) && port >= 5554 && port <= 5584 && port % 2 === 0) return undefined;
  return (
    `\`port\` ${port} is not an emulator console port. ` +
    "Pass an even number from 5554 to 5584, the range adb finds emulators in, or omit `port`."
  );
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
  harmony: { emulator: true },
  macos: { app: true, catalyst: true },
};

// The exactly-one check over `udid`/`avdName`/`vvdImage`/`harmonyInstance`/`electronAppPath`/
// `macosAppPath` lives in `execute`; the tool description states the constraint for MCP clients.
const zodSchema = z.object({
  udid: z
    .string()
    .optional()
    .describe(
      "iOS: simulator UDID to boot (from `list-devices`).<flag:macos-apps> A Mac app id (`macos-app-<bundle id>`) starts that app again from its last path.</flag:macos-apps>"
    ),
  avdName: z
    .string()
    .optional()
    .describe(
      "Android: AVD to start, the `avdName` of a `list-devices` entry with kind 'avd'. A running emulator of it is reused when it fits the call: see `readOnly` and `port`."
    ),
  vvdImage: z
    .string()
    .optional()
    .describe(
      "Vega (Fire TV): VVD image to boot: the `vvdImage` of a Vega device from `list-devices` (e.g. `tv`)."
    ),
  harmonyInstance: z
    .string()
    .optional()
    .describe(
      'HarmonyOS: emulator instance to start: the `name` of a `kind: "emulator"` device from `list-devices` (e.g. `Phone_1`); the `harmony-emulator-<name>` id that entry reports as its `udid` is accepted too.'
    )
    .meta({ [FLAG_META_KEY]: HARMONY_FLAG }),
  bootTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .optional()
    .describe(
      "Android/Vega<flag:harmonyos>/HarmonyOS</flag:harmonyos>: overall budget for the boot sequence. Default 480000 (8 min) on Android, 120000 (2 min) on Vega<flag:harmonyos>, 180000 (3 min) on HarmonyOS, where with `force` it spans the shutdown as well as the boot</flag:harmonyos>."
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Shut down and re-boot the device even if already running.<flag:harmonyos> On HarmonyOS it is also what ties an already-running instance to its `hdc` connect key: without it the instance is left alone and its key stays unresolved (`list-devices` lists the keys, but not which instance each belongs to).</flag:harmonyos><flag:macos-apps> On a Mac app it quits and restarts the app, also a copy of the same build running without the argent library: that copy loses its unsaved changes. When the app argent runs answers the quit with a save prompt, the call fails and the app keeps running. Force never quits a copy of another build (another .app path).</flag:macos-apps> Ignored for Electron: each boot spawns a new process, and an `electronPort` that a process already listens on is refused."
    ),
  sound: z
    .boolean()
    .optional()
    .describe(
      "Android only (argent never mutes other platforms): boot the emulator with audio output enabled. Defaults to false, so several agent-driven emulators don't all play sound on the host; pass `true` when the task involves playing, hearing, or testing audio. Takes effect at boot: if the emulator is already running muted, add `force: true`. The first boot after toggling is a slower cold boot (the snapshot was saved in the other audio mode). The `boot-sound` argent flag flips this default to true."
    ),
  guestVulkan: z
    .boolean()
    .optional()
    .describe(
      "Android on a macOS host only: boot the emulator with guest Vulkan. Defaults to false: guest Vulkan crashes Chrome's GPU process, which breaks Chrome and Custom Tab sign-in flows. Without it apps find no Vulkan device, although the guest still lists the Vulkan features, so a Vulkan-only renderer such as WebGPU (react-native-wgpu) draws nothing; pass `true` to test one. Takes effect at boot: an emulator already running in the other mode is reused with a `note`, and `force: true` reboots it. A boot snapshot saved in the other mode can't be reused, so the first boot after toggling is a slower cold boot. The `ARGENT_EMULATOR_GUEST_VULKAN` env var flips this default to true. Ignored on other hosts and platforms."
    ),
  readOnly: z
    .boolean()
    .optional()
    .describe(
      "Android only: boot the emulator with `-read-only`, so that several emulators can run one AVD at once, for example one per agent. Defaults to false. A read-only emulator saves no snapshot and loses its changes when it exits, so the AVD and its quickboot snapshot stay as they were. The emulator runs an AVD either writable once or read-only any number of times, never both, so the boot fails while the AVD runs writable, and a writable boot fails while the AVD runs in any instance it cannot reuse. A read-only boot reuses only a running read-only emulator. Ignored on other platforms."
    ),
  // The range is checked on the Android path only (`androidPortError`): off
  // Android the key is ignored, so an agent echoing a Chromium `port` such as
  // 9222 must not fail validation.
  port: z
    .number()
    .int()
    .optional()
    .describe(
      "Android only: the emulator's console port, an even number from 5554 to 5584 (`emulator -port`), the range adb finds emulators in; its serial is `emulator-<port>`. Without it the emulator takes the first free port from 5554 up, as Android Studio does. The gRPC server Argent needs for screenshots and gestures goes on the port plus 3000, which must be free too. Given a port, the tool reuses only the emulator on that port and fails if another emulator holds it, or if this AVD runs there writable on a read-only boot and `force` is not set. A read-only emulator started with `-port` belongs to the calls that give that port: a call without `port` never reuses or shuts it down. Where the process list cannot be read (Windows, or a failed `ps`), Argent knows only the pinned emulators it booted itself, so a writable call without `port` can reuse, or with `force` shut down, one that someone else pinned. A writable one is still reused, or with `force` shut down, by a writable call without `port`, since the AVD runs one writable emulator at a time. `force` shuts nothing down when another emulator of the AVD would still block the boot. Ignored on other platforms."
    ),
  prepareOnly: z
    .boolean()
    .optional()
    .describe(
      "Local iOS simulator only: apply accessibility preferences and leave the simulator shut down for a pool manager to boot. Requires Shutdown state. Cannot be combined with force: true."
    ),
  headless: z
    .boolean()
    .optional()
    .describe(
      "iOS only: boot the simulator core WITHOUT opening its GUI window (Simulator.app, or Device Hub on Xcode 27+). The device still streams via simulator-server. The `ARGENT_SIMULATOR_NO_WINDOW` env var (1/true/yes) forces this host-wide."
    ),
  electronAppPath: z
    .string()
    .optional()
    .describe(
      "Electron: path to the Electron app to launch. Either a packaged .app bundle / executable, or a project directory whose package.json points the Electron binary at the entry script."
    ),
  electronPort: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .describe(
      "Electron-only: CDP remote-debugging port to expose. Defaults to a free port; the resulting device id is `chromium-cdp-<port>`. A port that a process already listens on is refused."
    ),
  electronArgs: z
    .array(z.string())
    .optional()
    .describe(
      "Electron-only: extra CLI arguments forwarded to the Electron binary after the app path."
    ),
  macosAppPath: z
    .string()
    .optional()
    .describe(
      "Mac app: path to the .app bundle to start with the argent library; its device id is `macos-app-<bundle id>`. An exported or notarized Release build with the hardened runtime cannot be driven without extra entitlements; a hardened Debug build needs the step the error names."
    )
    .meta({ [FLAG_META_KEY]: MACOS_APPS_FLAG }),
  macosAppArgs: z
    .array(z.string())
    .optional()
    .describe(
      "Mac app only: arguments for the app executable. Omitted, the app starts with none, also when an earlier start had some."
    )
    .meta({ [FLAG_META_KEY]: MACOS_APPS_FLAG }),
});

type BootDeviceParams = z.infer<typeof zodSchema>;

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  return {
    id: "boot-device",
    // Boots routinely run past the 30s MCP fetch timeout.
    longRunning: true,
    description: `Start an iOS simulator, launch an Android emulator, start a Vega (Fire TV) Virtual Device, <flag:harmonyos>start a HarmonyOS emulator, </flag:harmonyos><flag:macos-apps>launch a built Mac app, </flag:macos-apps>or spawn an Electron app and wait until it is ready to accept interactions.
Pass exactly one of 'udid', 'avdName', 'vvdImage', <flag:harmonyos>'harmonyInstance', </flag:harmonyos><flag:macos-apps>'macosAppPath', </flag:macos-apps>or 'electronAppPath'; it picks the platform.
Use when starting a session, once you have picked a target.
Returns a tagged payload: { platform: 'ios', udid, booted, note? } or { platform: 'android', serial, avdName, booted, note? } or { platform: 'vega', serial, vvdImage, booted } or <flag:harmonyos>{ platform: 'harmony', udid, instanceName, booted, note? } or </flag:harmonyos>{ platform: 'chromium', id, port, pid, booted } (an Electron app boots as a Chromium/CDP device).<flag:macos-apps>
Mac apps return platform 'macos' and kind 'catalyst' or 'app'. Pass the returned id as udid to interaction tools. Follow the note when present.</flag:macos-apps>
On Android the tool hot-boots from the AVD's default_boot snapshot when usable and falls back to a slower cold boot otherwise. Vega starts the single SDK-managed VVD (~10s). If an Android/Electron boot stage fails, the tool terminates the device it spawned so the next retry starts clean.<flag:harmonyos>
HarmonyOS hands the instance to DevEco Studio's Emulator manager, then waits for it to register with 'hdc' and returns its connect key as 'udid', the id the interaction tools drive. The manager reports no readiness signal and never names a port. When the key could not be resolved, the payload names the instance instead, and a 'note' is present whenever the boot left something unproven: no key and why, or a key that is not yet answering or could not be checked against the instance. Huawei serves the emulator images only within mainland China, so a host outside it usually has no instance to start; one that already has an image is started like any other.</flag:harmonyos>`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "boot start launch simulator emulator avd device session ios android vega vvd firetv <flag:harmonyos>harmony harmonyos deveco </flag:harmonyos>cold hot",
    interaction: {
      startedMsg: ({ params }) =>
        `${params.prepareOnly ? "Preparing" : "Starting"} ${bootTarget(params)}`,
      completedMsg: ({ params }) =>
        `${params.prepareOnly ? "Prepared" : "Started"} ${bootTarget(params)}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to ${params.prepareOnly ? "prepare" : "start"} ${bootTarget(params)}: ${failureSignal.error_code}`,
    },
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const hasUdid = Boolean(params.udid);
      const hasAvd = Boolean(params.avdName);
      const hasVega = Boolean(params.vvdImage);
      const hasHarmony = Boolean(params.harmonyInstance);
      const hasElectron = Boolean(params.electronAppPath);
      const hasMacos = Boolean(params.macosAppPath);
      const provided = [hasUdid, hasAvd, hasVega, hasHarmony, hasElectron, hasMacos].filter(
        Boolean
      ).length;
      if (provided !== 1) {
        throw new InvalidToolInputError(
          renderFlagGated(
            "Provide exactly one of `udid` (iOS), `avdName` (Android), `vvdImage` (Vega VVD), <flag:harmonyos>`harmonyInstance` (HarmonyOS), </flag:harmonyos><flag:macos-apps>`macosAppPath` (Mac app), </flag:macos-apps>or `electronAppPath` (Electron).",
            isFlagOffered
          ),
          {
            error_code: FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID,
            failure_stage: "boot_device_target_selection",
          }
        );
      }
      if (
        params.prepareOnly &&
        (!params.udid || classifyDevice(params.udid) !== "ios" || params.force)
      ) {
        throw new InvalidToolInputError(
          "prepareOnly requires a local iOS simulator UDID and cannot be combined with force: true."
        );
      }
      if (hasMacos || (hasUdid && classifyDevice(params.udid!) === "macos")) {
        return bootMacosApp(registry, {
          appPath: params.macosAppPath,
          deviceId: hasUdid ? params.udid : undefined,
          args: params.macosAppArgs,
          force: params.force,
        });
      }
      if (hasUdid) {
        /**
         * Argent attaches to a provider's device, it does not own its
         * lifecycle. `InvalidToolInputError` maps to a 400, so the agent is
         * told to ask the provider instead of getting a raw `simctl` failure.
         *
         * The raw udid is refused too, `bootIos` reboots the simulator and the
         * spelling the agent used does not change whose device it is.
         * `additionalDeviceSets` surfaces such a device by its real udid.
         *
         * `ext:` failures get the provider named at the HTTP edge, so naming it
         * here as well would print it twice. A raw udid gets no such
         * attribution, hence the name inline.
         */
        const claim = externalClaimForNativeId(params.udid!);

        if (isExternalId(params.udid!) || claim) {
          throw new InvalidToolInputError(
            `'${params.udid}' is supplied by ${claim ? claim.provider.name : "an external provider"}, ` +
              `which owns its lifecycle — argent cannot boot, reboot or shut it down. ` +
              `Start the device from that application, then it will appear in list-devices.`,
            {
              error_code: FAILURE_CODES.EXTERNAL_DEVICE_LIFECYCLE_REFUSED,
              error_kind: "unsupported",
              failure_area: "tool_server",
              failure_stage: "boot_device_external_refused",
            }
          );
        }
        const platform = classifyDevice(params.udid!);
        if (platform === "ios-remote") {
          const simUdid = stripRemotePrefix(params.udid!);
          if (nativeIdPlatform(simUdid) !== "ios" || isIosPhysicalUdid(simUdid)) {
            throw new InvalidToolInputError(
              `'${params.udid}' is not \`remote:<simulator udid>\`.`,
              {
                error_code: FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID,
                failure_stage: "boot_device_target_selection",
              }
            );
          }
          return bootIosRemote(params.udid!, registry, params.force);
        }
        // The capability gate admits only HarmonyOS emulator instances here.
        if (platform === "harmony") {
          return bootHarmony({
            instanceName: harmonyInstanceName(params.udid!),
            bootTimeoutMs: params.bootTimeoutMs ?? HARMONY_BOOT_TIMEOUT_MS,
            force: params.force,
          });
        }
        // A Mac app id never gets here: bootMacosApp took it above.
        const hint =
          platform === "ios" || platform === "macos"
            ? undefined
            : nonIosUdidHint(params.udid!, platform);
        if (hint) {
          throw new InvalidToolInputError(
            `\`udid\` takes an iOS simulator UDID from \`list-devices\`; \`${params.udid}\` is not one. ` +
              hint,
            {
              error_code: FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID,
              failure_stage: "boot_device_target_selection",
            }
          );
        }
        return bootIos(params.udid!, registry, params.force, params.headless, params.prepareOnly);
      }
      if (hasAvd) {
        if (params.port !== undefined) {
          const reason = androidPortError(params.port);
          if (reason) {
            throw new InvalidToolInputError(reason, {
              error_code: FAILURE_CODES.BOOT_ANDROID_PORT_INVALID,
              failure_stage: "boot_android_port",
            });
          }
        }
        return bootAndroid({
          avdName: params.avdName!,
          bootTimeoutMs: params.bootTimeoutMs ?? 480_000,
          force: params.force,
          // An explicit argument always wins; the `boot-sound` flag only moves
          // the default when the caller left `sound` unset. Read live per call
          // so `argent enable/disable boot-sound` applies without a restart.
          sound: params.sound ?? isFlagEnabled("boot-sound"),
          guestVulkan: params.guestVulkan ?? androidGuestVulkanFromEnv(),
          readOnly: params.readOnly ?? false,
          port: params.port,
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
      const electronBoot = () =>
        bootElectronApp({
          appPath: params.electronAppPath!,
          port: params.electronPort,
          extraArgs: params.electronArgs,
        });
      const fixedPort = params.electronPort;
      // A fixed port can be one a restart-app or e2e teardown is working on.
      return fixedPort === undefined
        ? electronBoot()
        : withPortLock(fixedPort, async () => {
            await assertElectronPortFree(fixedPort);
            try {
              return await electronBoot();
            } catch (err) {
              // This boot was to replace the port's app, so restart-app must not
              // relaunch the one it replaced.
              forgetElectronLaunchSpec(fixedPort);
              throw err;
            }
          });
    },
  };
}

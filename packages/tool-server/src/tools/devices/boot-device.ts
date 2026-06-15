import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import {
  buildInitFailedResult,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";
import {
  ensureAutomationEnabled,
  isEntitlementBypassActive,
  setAccessibilityPrefsPreBoot,
} from "../../blueprints/ax-service";
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
import { bootElectronApp, type ElectronBootResult } from "./boot-electron";

const execFileAsync = promisify(execFile);

// NOTE on mutual exclusion: `udid` and `avdName` are exactly-one — but zod's
// `.refine()` returns a ZodEffects that our Registry ToolDefinition type does
// not accept (it requires a ZodObject so the JSON Schema generator can walk
// `.shape`). The exactly-one check therefore lives inside `execute` and
// surfaces with a specific error message on the first call. We restate the
// constraint in each field's `.describe()` so MCP clients still see it in the
// generated tool docs even if their JSON-schema inspector ignores the runtime.
const zodSchema = z.object({
  udid: z
    .string()
    .optional()
    .describe(
      "iOS: simulator UDID to boot (from `list-devices`). Provide exactly one of `udid` or `avdName`."
    ),
  avdName: z
    .string()
    .optional()
    .describe(
      "Android: AVD name to launch a new emulator from (from `list-devices` → `avds[].name`). Provide exactly one of `udid` or `avdName`."
    ),
  bootTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .optional()
    .describe(
      "Android-only: overall budget for the full boot sequence. Defaults to 480000 (8 min). Clamped to [30s, 15min]. Ignored on iOS."
    ),
  force: z
    .boolean()
    .optional()
    .describe("Shut down and re-boot the device even if already running."),
  electronAppPath: z
    .string()
    .optional()
    .describe(
      "Electron: path to the Electron app to launch. Either a packaged .app bundle / executable, or a project directory whose package.json points the Electron binary at the entry script. Mutually exclusive with udid/avdName."
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
  | { platform: "android"; serial: string; avdName: string; booted: true }
  | ElectronBootResult
  | NativeDevtoolsInitFailedResult;

// Flags every boot-device launch should always pass. Two purposes:
//
//   - Performance: `-noaudio` skips guest pulseaudio init (one thread, ~50 MB
//     RSS); `-no-boot-anim` skips the Pixel boot animation, which is a major
//     CPU spike on software-rendered GPU modes; `-netfast` disables network
//     shaping (latency/speed simulation), pure overhead for MCP use cases.
//     Measured on a 4-core Skylake host with a 4096 MB / 228 MB-heap AVD:
//     warm-cache cold boot drops 66 s → 49 s (~25%), qemu RSS at +20 s drops
//     ~190 MB. android-emulator-runner (the canonical CI launcher) passes the
//     same three by default for the same reasons.
//
//   - Dialog suppression: `-crash-report-mode never` keeps emulator crashes
//     from popping a Qt consent dialog that blocks the next boot until a
//     human dismisses it; `-no-metrics` suppresses the metrics-collection
//     consent dialog with the same blocking behavior. Crash dumps are still
//     written to /tmp/android-unknown/emu-crash-*.db so the data isn't lost
//     — only the modal popup is. `-no-metrics` is Google's anonymous
//     emulator-usage telemetry and is unrelated to any argent profiler tool
//     (those run guest-side via Perfetto/simpleperf or Metro CDP).
//
// All five are flag-only with no host detection, so they apply uniformly to
// macOS and Linux. `-noaudio` and `-netfast` change qemu device topology,
// which means they must be passed identically to the snapshot probe, hot
// boot, and cold boot — a mismatch would silently invalidate the snapshot
// the previous cold boot saved.
const LAUNCH_HARDENING_ARGS = [
  "-noaudio",
  "-no-boot-anim",
  "-netfast",
  "-crash-report-mode",
  "never",
  "-no-metrics",
] as const;

// Each stage has its own sub-budget so a hang in one stage cannot consume the
// entire overall budget and a bootTimeoutMs bump doesn't quietly mask a regression.
const STAGE_BUDGET = {
  adbRegister: 60_000, // adb devices sees the serial for this AVD
  deviceReady: 180_000, // adb -s wait-for-device returns (state === "device")
  bootCompleted: 300_000, // sys.boot_completed = 1
  pmReady: 45_000, // pm path android answers (retried; non-fatal on the final attempt)
  firstRealFrame: 90_000, // screencap returns ≥1 non-zero pixel after cold boot
  firstRealFrameHot: 8_000, // tighter budget for snapshot-restore composite —
  // the broken state is sticky (per assertScreencapAlive's docstring), so a
  // few seconds is enough to discriminate transient blanks from genuine wedge.
} as const;

// Whitelist of -gpu values the emulator binary accepts (per `emulator -help-gpu`).
// We validate the override at boot-start instead of letting the emulator reject
// a typoed value mid-launch: that path otherwise burns the full hot-boot budget
// before surfacing the error, which is the worst possible UX for a 1-line fix.
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

// Linux: `-gpu auto` lands on `hw.gpu.mode=lavapipe` (slow CPU Vulkan via host
// libvulkan + Mesa shims, ~10× cold-boot regression), and `-gpu host` silently
// produces a corrupted/black emulator window on dual-GPU laptops, NVIDIA+Mesa
// hosts via libglvnd, Wayland sessions on hybrid graphics, and containerized
// hosts — argent's screencap-based screenshot tool reports success while the
// developer sees a black window. `swiftshader` (emulator's bundled CPU
// renderer) sidesteps both traps and is indistinguishable from `host` on
// modern multi-core machines. `ARGENT_EMULATOR_GPU_MODE` overrides. macOS
// uses `auto` (resolves to ANGLE→Metal, hardware-accelerated).
function selectGpuMode(): string {
  const override = process.env.ARGENT_EMULATOR_GPU_MODE;
  if (override && override.trim()) {
    const value = override.trim();
    if (!VALID_GPU_MODES.has(value)) {
      throw new Error(
        `ARGENT_EMULATOR_GPU_MODE=${JSON.stringify(value)} is not a known emulator -gpu value. ` +
          `Valid values: ${[...VALID_GPU_MODES].join(", ")}.`
      );
    }
    return value;
  }
  return process.platform === "linux" ? "swiftshader" : "auto";
}

// Opt-in `-no-window` for CI/containers/Wayland sessions where the emulator's
// bundled Qt has no wayland plugin (would SIGABRT). `-no-window` selects
// qemu-system-x86_64-headless which skips Qt entirely; screencap still works.
// Accepted truthy values: "1", "true", "yes" (case-insensitive). Anything else
// — including "false", "no", "0", or empty — is treated as disabled.
function selectExtraEmulatorArgs(): string[] {
  const trimmed = (process.env.ARGENT_EMULATOR_NO_WINDOW ?? "").trim().toLowerCase();
  return ["1", "true", "yes"].includes(trimmed) ? ["-no-window"] : [];
}

// Poll cadences for the boot state machine. These intervals only pace how
// often we re-probe adb between attempts — they bound latency, not
// correctness. Values are deliberately conservative: a hung adb on the
// default 30s timeout must not be re-spawned every few ms. Timing-sensitive
// tests drive these with vitest fake timers rather than mutating production
// state, so this stays an immutable constant.
const BOOT_POLL_INTERVALS_MS = {
  serialByAvd: 1_500, // findSerialByAvdName: re-scan when >1 new emulator appeared
  adbRegister: 1_000, // attemptBoot stage 2: re-scan adb devices for the new serial
  earlyExit: 500, // createEarlyExitRacer: re-check the crash latch during a blocking adb call
} as const;

// Probe pipeline shared by assertScreencapAlive (hot-boot guard) and
// awaitFirstRealFrame (cold-boot guard). `screencap -p` emits a PNG of the
// current frame; awk thresholds the byte count. Real content is reliably
// >20 KB; a uniform-color frame (sticky-blank or pre-composite) RLE/deflates
// to <10 KB regardless of resolution — see assertScreencapAlive's docstring
// for why raw-RGBA byte sniffing isn't sufficient. Outputs exactly "1" or "0".
// `wc -c` of empty input is "0" so a missing/failed screencap surfaces as
// "0" rather than a silent pass. Starts with the literal token "screencap"
// so existing test mocks that match on shellCmd.startsWith("screencap") still fire.
const FRAME_PROBE = "screencap -p 2>/dev/null | wc -c | awk '$1>20000{print 1;exit} {print 0}'";

async function killEmulatorQuietly(
  serial: string | null,
  child?: import("node:child_process").ChildProcess
): Promise<void> {
  // Preferred path: emulator console's kill command (the supported API).
  // It drains pending writes — including a mid-save ram.bin on the cold path
  // — before qemu exits. Generous timeout because a graceful flush of a
  // multi-hundred-MB ram.bin under host memory pressure can take several
  // seconds, and we'd rather wait than orphan a half-written snapshot.
  if (serial) {
    await runAdb(["-s", serial, "emu", "kill"], { timeoutMs: 15_000 }).catch(() => {});
  }
  if (!child) return;
  // Fallback for a wedged console (hypervisor stall, GPU driver reset, IO-
  // thread deadlock — all leave qemu alive but deaf to `adb emu kill`).
  // SIGTERM, not SIGKILL: qemu installs a SIGTERM handler that mirrors the
  // console-kill flush path, so a writable snapshot stays consistent. SIGKILL
  // could truncate an in-flight ram.bin write and poison the next boot.
  // Fire-and-forget — if qemu ignores SIGTERM too, it is unrecoverably stuck
  // and blocking our caller any longer just delays the user's next action.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// Best-effort termination for an emulator that was spawned detached + unref'd
// but never registered with adb — in that state `adb emu kill` has no serial
// to target, so we must signal the ChildProcess directly. SIGTERM only
// (fire-and-forget): qemu's SIGTERM handler mirrors the console-kill flush
// path, keeping any in-progress snapshot save consistent. SIGKILL could
// truncate a mid-write ram.bin; if qemu ignores SIGTERM it is wedged past
// recovery and blocking the caller any longer is worse than walking away.
function killDetachedEmulator(child: import("node:child_process").ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Verify that `screencap` returns real pixel data, not an all-zero buffer.
 *
 * Observed failure: on a hot-boot restore, every Android-side readiness probe
 * passes (`sys.boot_completed=1`, `pm path android` resolves, launcher is the
 * focused window, SurfaceFlinger reports the display as enabled, `gfxinfo`
 * confirms frames are rendering) yet every pixel `screencap` returns is
 * `(0,0,0,0)`. The broken frame is sticky: waking the screen, dismissing
 * keyguard, toggling power, swiping, launching a new activity, and capturing
 * on-device (`screencap /sdcard/shot.png`) all produce the same all-zero
 * output. Only a cold boot restores a working capture path. Hypothesis:
 * SurfaceFlinger's host-side composite buffer is not restored with the guest
 * state, so any screenshot reader sees an unhydrated framebuffer. The exact
 * trigger isn't fully pinned down — fresh snapshots saved on this host do not
 * reproduce it today, but the sticky-blank state has been observed after
 * long-lived emulator sessions and against stale snapshots. A caller who
 * trusts `booted:true` and screenshots the device gets a silently-wrong blank
 * image, which is worse than a slower boot; we pay ~200 ms per hot boot to
 * eliminate that failure mode entirely.
 *
 * Detection: take a PNG of the current frame and threshold its byte count.
 * A uniform-color image (the sticky-blank / pre-composite case) compresses
 * to a few KB even at full resolution; a real frame with any UI on it is
 * reliably >20 KB. We can't probe the raw RGBA buffer with a simple
 * "any non-zero byte" check because Android fills uninitialised framebuffers
 * with `(0,0,0,0xFF)` — opaque black — so every 4th byte (alpha) is already
 * non-zero before SurfaceFlinger has drawn anything, which would silently
 * report a blank frame as healthy. PNG byte-count sidesteps the alpha
 * pitfall: uniform alpha-only content RLE/deflates to ~7 KB regardless of
 * pixel count, real content blows past the threshold.
 *
 * Polling, not a single probe: snapshot restore can produce a transient blank
 * for up to 30 s under SwiftShader before the composite hydrates. A
 * single-probe assertion landing inside that window would kill the emulator
 * and force a cold boot every time, defeating the whole point of hot-booting.
 * We poll until either a real frame shows up (success) or `budgetMs` expires
 * (sticky blank — kill the emulator so the outer catch can fall through to
 * cold boot, and the eventual serial is always usable for screenshots).
 */
async function assertScreencapAlive(
  serial: string,
  budgetMs: number = STAGE_BUDGET.firstRealFrameHot
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Match success on "1" specifically: empty output (screencap binary missing,
  // exec-out drained nothing) used to trim to "" which !== "0" and silently
  // returned success — i.e. a broken capture path was reported as healthy.
  // Any non-"1" reading (zero pixels OR no output at all) is a failure.
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
  throw new Error(
    `hot-boot composite did not restore within ${budgetMs / 1000}s — \`screencap\` last returned ` +
      `${JSON.stringify(lastReading ?? "no probe response")}. Falling back to cold boot so screenshots are usable.`
  );
}

/**
 * Cold-boot counterpart to `assertScreencapAlive`.
 *
 * `sys.boot_completed=1` fires before SurfaceFlinger has actually composited
 * the lockscreen — on Linux + Weston-headless + SwiftShader software rendering
 * the gap is 5–60 s. Callers that trust `booted:true` and immediately screenshot
 * get an all-black 324×720 PNG (~5 KB) instead of a real lockscreen frame.
 *
 * Unlike the hot-boot case the blank is *transient* — we just need to wait for
 * the first real composite. Same on-device probe as `assertScreencapAlive`
 * (PNG byte-count, see `FRAME_PROBE`), polled until a frame crosses the size
 * threshold or the deadline is hit. We also issue `KEYCODE_WAKEUP` once on
 * entry in case the display was driven straight to dim/off after boot
 * (cheap, idempotent — no-op if already awake).
 *
 * On deadline expiry we throw without killing the emulator: the caller's outer
 * cold-boot catch already wraps with the "wipe-data" hint, and at this point
 * the device is otherwise healthy, so we'd rather surface the timeout than
 * orphan a working AVD.
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
  throw new Error(
    `SurfaceFlinger did not composite a real frame within ${timeoutMs / 1000}s of boot_completed ` +
      `(${lastError ?? "no probe response"}). The emulator booted but every screenshot would be all-black.`
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
  force?: boolean
): Promise<{ platform: "ios"; udid: string; booted: true } | NativeDevtoolsInitFailedResult> {
  // Catch the non-darwin case before `ensureDep("xcrun")` so a Linux user
  // gets "iOS requires macOS" rather than a misleading "install xcode-select".
  if (process.platform !== "darwin") {
    throw new Error(
      `iOS Simulator is unavailable on ${process.platform}: it requires a macOS host. ` +
        `Pass \`avdName\` (Android) instead of \`udid\` (iOS) to boot a device from this host.`
    );
  }
  await ensureDep("xcrun");

  const simState = await listIosSimulators()
    .then((sims) => sims.find((s) => s.udid === udid)?.state)
    .catch(() => undefined);

  // force=true on a running sim: shut it down so we can pre-write AX prefs.
  if (force && simState === "Booted") {
    await execFileAsync("xcrun", ["simctl", "shutdown", udid]);
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

  await execFileAsync("xcrun", ["simctl", "boot", udid]).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Unable to boot device in current state: Booted")) {
      throw err;
    }
  });
  await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"]);

  // Best-effort fallback: no-op on the happy path (pref already cached from
  // pre-boot write). When the sim was already Booted without force, writes
  // prefs via `defaults write` — SB won't pick them up until next restart,
  // but describe surfaces a hint about it.
  await ensureAutomationEnabled(udid).catch(() => undefined);

  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  const ndApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  const initFailure = ndApi.getInitFailure();
  if (initFailure?.givenUp) {
    return buildInitFailedResult(udid, initFailure);
  }
  await execFileAsync("defaults", [
    "write",
    "com.apple.iphonesimulator",
    "CurrentDeviceUDID",
    udid,
  ]);
  await execFileAsync("open", ["-a", "Simulator.app"]);
  return { platform: "ios", udid, booted: true };
}

// Tight budget for a hot boot attempt. A successful hot boot completes well
// under 15 s on fast hardware and under ~45 s on a cold host page cache; the
// 90 s ceiling exists to bound the pathological case where snapshot load
// succeeds but the guest system_server is stuck — without this cap, a silent
// system-server hang would eat the full cold-boot budget before we retry.
const HOT_BOOT_BUDGET_MS = 90_000;

/**
 * Attempt a single boot with the supplied emulator args. Extracted from
 * `bootAndroid` so the hot-boot path and the cold-boot fallback share every
 * stage without diverging. The caller supplies the serialsBefore snapshot
 * (captured once per `bootAndroid` invocation, *before* either attempt)
 * because recomputing it between attempts would include the serial from the
 * failed hot-boot child if reaping is still in flight.
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
  // Whether a PM probe that never succeeds should tear the emulator down and
  // throw. True on the hot-boot attempt (so the caller can fall back to a cold
  // boot); false on the final cold attempt, where a slow-but-alive guest is
  // returned as booted rather than destroyed.
  tearDownIfUnready: boolean;
}): Promise<{ serial: string }> {
  const child = spawn(params.emulatorBinary, params.emulatorArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  let earlyExitError: Error | null = null;
  child.on("exit", (code, signal) => {
    // A QEMU SIGSEGV/SIGABRT comes through as `code === null, signal !== null`.
    // The previous `code !== null` guard treated those as a normal exit, so a
    // hot-boot child that segfaulted on a bad ram.bin restore would hang the
    // outer wait until the per-stage budget elapsed instead of failing fast.
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
  // `spawn` itself can fail (ENOENT — emulator binary missing/EACCES, transient
  // FS hiccup) by emitting an `error` event on the child. EventEmitter
  // convention is that an unhandled `error` escapes as an uncaught exception
  // that would crash the tool-server. Funnel it into the same earlyExitError
  // race so the boot promise rejects with the actual cause and the in-flight
  // Map entry (cleared by `bootAndroid`'s `finally`) doesn't leak.
  child.on("error", (err: NodeJS.ErrnoException) => {
    earlyExitError = new Error(
      `Failed to spawn emulator binary (${err.code ?? "unknown"}): ${err.message}. ` +
        `Verify Android SDK Emulator is installed and on PATH, then retry.`
    );
  });

  // Stage 2: wait for adb to see the new emulator.
  let serial: string | null = null;
  const adbDeadline = Math.min(params.attemptDeadline, Date.now() + params.adbRegisterBudgetMs);
  try {
    while (Date.now() < adbDeadline) {
      if (earlyExitError) throw earlyExitError;
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
    if (earlyExitError) {
      killDetachedEmulator(child);
      throw earlyExitError;
    }
    killDetachedEmulator(child);
    throw new Error(
      `Emulator "${params.avdName}" did not register within ${params.adbRegisterBudgetMs / 1000}s. ` +
        `The emulator process has been terminated.`
    );
  }

  // Stage 3: wait-for-device (tcp socket up).
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

  // Stage 4: sys.boot_completed = 1.
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
  // sys.boot_completed=1 so this is the first real proof the guest is live.
  // `pm` can take tens of seconds to answer on a loaded host or a freshly
  // wiped image still finishing its first-boot package scan, even though the
  // device is healthy and already registered with adb — so retry within a
  // budget instead of failing on a single 10 s window. Each attempt races
  // earlyExitError so a real crash surfaces with the actual signal/exit-code
  // error rather than a misleading "PackageManager did not respond".
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
    // A confirmed crash (mid-probe or via the exit racer) always tears down and
    // rethrows the real cause.
    const crash = pmCrash ?? earlyExitError;
    if (crash) {
      await killEmulatorQuietly(serial, child);
      throw crash;
    }
    // Tear down only when there is still a fallback left to try (hot boot ->
    // cold boot). On the final attempt a slow-but-alive guest is NOT a reason
    // to destroy it: it reached boot_completed and registered with adb, gRPC
    // screenshots/gestures work without PM, and killing it guarantees failure
    // with nothing to fall back to.
    if (params.tearDownIfUnready) {
      await killEmulatorQuietly(serial, child);
      throw new Error(
        `PackageManager did not respond on ${serial} within ${Math.round(pmBudgetMs / 1000)}s ` +
          `after boot_completed. Emulator has been terminated.`
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

// In-flight boot per AVD. Two `bootAndroid` calls for the same AVD would each
// pass the "already running" fast-path (the emulator hasn't registered yet)
// and both spawn QEMU — the second collides on the AVD's exclusive on-disk
// lock and bails after the boot deadline with a confusing "Running multiple
// emulators" error. Coalescing in-flight calls per AVD makes a duplicate call
// reuse the result of the first one (or its eventual error).
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
 * Clear the in-flight boot map. Exposed for tests that intentionally abandon
 * a half-started boot to assert orphan-cleanup behavior — without this hook
 * the leaked promise would coalesce into the next test that targets the same
 * AVD and starve it of a real spawn.
 */
export function __resetInFlightBootsForTesting(): void {
  inFlightBoots.clear();
}

async function bootAndroid(params: {
  avdName: string;
  bootTimeoutMs: number;
  force?: boolean;
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
}): Promise<{
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
}> {
  // Preflight both Android binaries up front so a missing emulator package
  // surfaces as a 424 "install hint" — not a misleading "no AVDs" error from
  // `listAvds()`'s empty result. `ensureDep("emulator")` consults the
  // resolver, which honors `$ANDROID_HOME` in addition to PATH.
  await ensureDep("adb");
  await ensureDep("emulator");
  // Validate and capture boot-configuration env vars upfront so a typo in
  // ARGENT_EMULATOR_GPU_MODE surfaces before any slow I/O (snapshot probe,
  // AVD list, emulator spawn) rather than mid-function with a misleading
  // "emulator has been terminated" suffix.
  const gpuMode = selectGpuMode();
  const extraEmulatorArgs = selectExtraEmulatorArgs();

  for (const msg of linuxBootDiagnostics(params.avdName) ?? []) {
    console.warn(`[boot-device:linux] ${msg}`);
  }
  const emulatorBinary = await resolveEmulatorOrThrow();
  const overallDeadline = Date.now() + params.bootTimeoutMs;

  // Stage 0: validate AVD exists. Past this point an empty AVD list really
  // does mean "user has no AVDs" (the binary is present); the preflight ruled
  // out the binary-missing case.
  const avds = await listAvds();
  if (avds.length === 0) {
    throw new Error(
      "`emulator -list-avds` returned no AVDs. Create one via Android Studio or `avdmanager create avd`."
    );
  }
  if (!avds.some((a) => a.name === params.avdName)) {
    throw new Error(
      `AVD "${params.avdName}" not found. Available: ${avds.map((a) => a.name).join(", ")}.`
    );
  }

  // Stage 0b: verify adb is on PATH *before* spawning the emulator, so we
  // don't orphan a detached emulator process just to later throw "adb missing".
  try {
    await runAdb(["version"], { timeoutMs: 5_000 });
  } catch (err) {
    throw new Error(
      `\`adb\` is not available on PATH (${
        err instanceof Error ? err.message : String(err)
      }). Install Android SDK Platform Tools before booting an emulator.`
    );
  }

  // Ensure the adb daemon is running BEFORE we snapshot the serial list.
  // If the daemon was down, `adb devices` returns [] — without this the
  // snapshot is empty and every currently-connected emulator later looks
  // "new", so the tool could hand back an unrelated emulator as "booted".
  await runAdb(["start-server"], { timeoutMs: 10_000 }).catch(() => {});
  const existingDevices = await listAndroidDevices().catch(() => []);

  // Fast path: if this exact AVD is already running and ready, reuse it
  // instead of spawning a second emulator that would collide on AVD locks,
  // burn the full 90 s hot-boot budget in the probe + spawn failure, and
  // surface a misleading "Running multiple emulators" error.
  let hotBootFailureReason: string | null = null;
  const alreadyRunning = existingDevices.find(
    (d) => d.isEmulator && d.avdName === params.avdName && d.state === "device"
  );
  if (alreadyRunning) {
    if (params.force) {
      await killEmulatorQuietly(alreadyRunning.serial);
      const refreshed = await listAndroidDevices().catch(() => existingDevices);
      existingDevices.splice(0, existingDevices.length, ...refreshed);
    } else {
      // BUG GUARD — wedged-framebuffer detection on the reuse path.
      // A long-running emulator can drift into the same sticky-blank
      // SurfaceFlinger state that `assertScreencapAlive` defends against on a
      // hot-boot restore (see its docstring): every Android-side readiness
      // probe still passes, but `screencap` only returns null bytes — meaning
      // the caller would silently get a serial whose screenshots are all
      // black. Without this probe the fast-path returns that wedged serial
      // forever and there is no way back, since `coldBoot` was removed.
      // On failure the helper kills the wedged emulator; we then fall through
      // to the snapshot/probe pipeline so the caller still gets a usable boot.
      try {
        await assertScreencapAlive(alreadyRunning.serial);
        return {
          platform: "android",
          serial: alreadyRunning.serial,
          avdName: params.avdName,
          booted: true,
        };
      } catch (err) {
        hotBootFailureReason = `running AVD framebuffer was wedged (${
          err instanceof Error ? err.message : String(err)
        }), respawning`;
        // assertScreencapAlive already killed the emulator; refresh the
        // existing-devices snapshot so the killed serial is included in
        // serialsBefore (matching the hot-boot catch refresh below) and the
        // upcoming spawn's "new serial" diff stays correct.
        const refreshed = await listAndroidDevices().catch(() => existingDevices);
        existingDevices.splice(0, existingDevices.length, ...refreshed);
      }
    }
  }
  const serialsBefore = new Set(existingDevices.map((d) => d.serial));

  // Suppress the emulator's crash-report prompt/uploader on builds that accept
  // the flag. `-crash-report-mode` is undocumented and only present in newer
  // emulator releases (~36.x and late 35.x), so feature-detect it via `-help`
  // rather than pass it blind: an unrecognized flag aborts the launch before
  // boot. Computed here (after the already-running reuse fast-path returns) so
  // the `-help` probe is skipped when we are not going to spawn, and shared by
  // both the hot- and cold-boot arg lists below.
  const crashReportArgs = (await emulatorSupportsFlag("-crash-report-mode"))
    ? ["-crash-report-mode", "never"]
    : [];

  // Decide whether to try a hot boot: only if a default_boot snapshot exists
  // on disk AND the emulator's own `-check-snapshot-loadable` probe says the
  // metadata is valid. Probe takes ~1-2 s and catches the two most common
  // silent-hang causes: renderer/GPU config drift and `snapshot.pb` metadata
  // corruption. On any hot-boot failure we fall back to cold boot below.
  const hasSnapshot = await hasDefaultBootSnapshot(params.avdName);
  if (!hasSnapshot) {
    hotBootFailureReason = "no default_boot snapshot exists";
  } else {
    // Probe and boot must share the same renderer-affecting argv — otherwise
    // the probe resolves a different renderer than the boot and rejects every
    // valid snapshot with "different renderer configured". RENDERER_ARGS
    // keeps the two in lockstep. `-gpu` value and the optional `-no-window`
    // come from `selectGpuMode` / `selectExtraEmulatorArgs` (resolved upfront).
    const RENDERER_ARGS = ["-gpu", gpuMode, ...extraEmulatorArgs];
    const probe = await checkSnapshotLoadable(params.avdName, "default_boot", {
      extraArgs: [...RENDERER_ARGS, ...LAUNCH_HARDENING_ARGS],
    });
    if (!probe.loadable) {
      hotBootFailureReason = `-check-snapshot-loadable: ${probe.reason ?? "unknown"}`;
    } else {
      // Hot boot attempt. `-force-snapshot-load` flips the emulator's default
      // "silent fallback to cold boot on load failure" into a loud early exit
      // so ram.bin corruption (which the probe misses) surfaces in seconds
      // rather than hanging for the full overall budget. `-no-snapshot-save`
      // avoids overwriting a working snapshot with state captured after we
      // later force-kill the child from a failure path.
      const hotArgs = [
        "-avd",
        params.avdName,
        "-force-snapshot-load",
        "-no-snapshot-save",
        ...RENDERER_ARGS,
        ...LAUNCH_HARDENING_ARGS,
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
          // Snapshot restores register with adb within a couple of seconds;
          // a minute-long register wait on the hot path would mask the
          // scenario where load fails and the child silently cold-boots.
          adbRegisterBudgetMs: 30_000,
          deviceReadyBudgetMs: 30_000,
          bootCompletedBudgetMs: 30_000,
          // Keep the hot path tight: a single ~10 s PM window, and tear down on
          // failure so we fall through to the cold boot below.
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
        // Best-effort: if the hot-boot child registered a serial before
        // failing, it's already been killed inside attemptBoot. If it didn't
        // register, any detached child was reaped there too. Refresh the
        // before-set so the cold-boot attempt doesn't misidentify a zombie
        // serial that has not yet disappeared from `adb devices` as "new".
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
  // LAUNCH_HARDENING_ARGS likewise — `-noaudio` and `-netfast` change device
  // topology, so a mismatch between cold-save and hot-load would invalidate
  // the saved snapshot.
  const coldArgs = [
    "-avd",
    params.avdName,
    "-no-snapshot-load",
    "-gpu",
    gpuMode,
    ...extraEmulatorArgs,
    ...LAUNCH_HARDENING_ARGS,
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
      // Final attempt: retry PM for longer, and do NOT tear the emulator down
      // if it stays slow — a guest that reached boot_completed is usable, and
      // there is no further fallback to justify destroying it.
      pmProbeBudgetMs: STAGE_BUDGET.pmReady,
      tearDownIfUnready: false,
    });
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const suffix = hotBootFailureReason
      ? ` Hot-boot was not viable (${hotBootFailureReason}).`
      : "";
    throw new Error(
      `${base} Emulator has been terminated so the next boot starts clean.` +
        ` If this keeps happening, wipe the AVD with \`emulator -avd ${params.avdName} -wipe-data\`.${suffix}`
    );
  }

  // Cold-boot post-condition: under SwiftShader the lockscreen composite lags
  // boot_completed by 5–60 s. Without this, a caller chaining boot-device →
  // screenshot gets a silent all-black PNG. See `awaitFirstRealFrame`.
  // Clamp against the remaining overallDeadline so the frame-wait stage cannot
  // push total elapsed time past bootTimeoutMs. Kill and throw on timeout so
  // the emulator doesn't linger until the next boot-device call.
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
 * Poll an exit-state getter and reject as soon as it returns non-null.
 * Used to race against a blocking adb call so a detached-emulator crash
 * surfaces as its specific error instead of a generic adb timeout.
 *
 * Returns `{ promise, cancel }`: the caller must call `cancel()` once the
 * race resolves, otherwise the recursive `setTimeout` chain keeps firing
 * for the life of the process — a real handle leak across many boot/restart
 * cycles. Always invoke `cancel()` in a `finally` block.
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
// rather than via `dispatchByPlatform` (the helper assumes a single udid
// input). Capability is still declared so the HTTP gate rejects an iOS udid
// on a host without xcrun, etc., and so `list-devices` consumers can rely on
// uniform metadata.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  return {
    id: "boot-device",
    description: `Start an iOS simulator, launch an Android emulator, or spawn an Electron app and wait until it is ready to accept interactions.
Pick the platform by which argument you pass: 'udid' for an iOS simulator from list-devices, 'avdName' for an Android AVD (a serial is assigned automatically), or 'electronAppPath' for an Electron app (a CDP remote-debugging port is picked automatically, or pass 'electronPort' to fix one).
Use at the start of a session once you have picked a target.
Returns a tagged payload: { platform: 'ios', udid, booted } or { platform: 'android', serial, avdName, booted } or { platform: 'chromium', id, port, pid, booted } (an Electron app boots as a Chromium/CDP device).
Android boots take 2–10 minutes depending on machine and cold/warm state; the tool transparently hot-boots from the AVD's default_boot snapshot when usable and falls back to cold boot otherwise. If any boot stage fails, the tool terminates the device it spawned so the next retry starts clean.`,
    alwaysLoad: true,
    searchHint: "boot start launch simulator emulator avd device session ios android cold hot",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const hasUdid = Boolean(params.udid);
      const hasAvd = Boolean(params.avdName);
      const hasElectron = Boolean(params.electronAppPath);
      const provided = [hasUdid, hasAvd, hasElectron].filter(Boolean).length;
      if (provided !== 1) {
        throw new Error(
          "Provide exactly one of `udid` (iOS), `avdName` (Android), or `electronAppPath` (Electron)."
        );
      }
      if (hasUdid) {
        return bootIos(params.udid!, registry, params.force);
      }
      if (hasAvd) {
        return bootAndroid({
          avdName: params.avdName!,
          bootTimeoutMs: params.bootTimeoutMs ?? 480_000,
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

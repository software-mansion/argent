import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import {
  adbShell,
  checkSnapshotLoadable,
  EMULATOR_BINARY,
  hasDefaultBootSnapshot,
  listAndroidDevices,
  listAvds,
  runAdb,
  waitForBootCompleted,
} from "../../utils/adb";
import { ensureDep } from "../../utils/check-deps";

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
  coldBoot: z
    .boolean()
    .optional()
    .describe(
      "Android-only: force a full cold boot and skip the AVD snapshot. Defaults to false — the tool first probes the default_boot snapshot with `-check-snapshot-loadable`, hot-boots with `-force-snapshot-load` and a tight deadline, and falls back to a cold boot on any hot-boot failure. Pass true to skip the hot-boot attempt entirely. Ignored on iOS."
    ),
  noWindow: z
    .boolean()
    .optional()
    .describe(
      "Android-only: launch the emulator headless (no UI window). Useful for CI. Defaults to false so you can see boot progress. Ignored on iOS."
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
});

type BootDeviceParams = z.infer<typeof zodSchema>;

type BootDeviceResult =
  | { platform: "ios"; udid: string; booted: true }
  | { platform: "android"; serial: string; avdName: string; booted: true; coldBoot: boolean };

// Each stage has its own sub-budget so a hang in one stage cannot consume the
// entire overall budget and a bootTimeoutMs bump doesn't quietly mask a regression.
const STAGE_BUDGET = {
  adbRegister: 60_000, // adb devices sees the serial for this AVD
  deviceReady: 180_000, // adb -s wait-for-device returns (state === "device")
  bootCompleted: 300_000, // sys.boot_completed = 1
} as const;

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
 * Detection: run the check on-device. `screencap` writes a 16-byte header
 * (width, height, format, colorspace) followed by raw RGBA pixel bytes;
 * `tail -c +17` skips the header, `tr -d '\0'` drops null bytes, and
 * `head -c 1 | wc -c` prints `1` if any byte survived or `0` if the stream
 * past the header was entirely null. `head` short-circuits as soon as one
 * non-zero byte appears, so a healthy frame costs microseconds of pixel
 * inspection — no host-side decode, no allocation, no iteration we own.
 *
 * On detection we throw; the outer catch in `bootAndroid` kills the hot child
 * and falls through to the cold path, so the serial that eventually reaches
 * the caller is always usable for screenshots.
 */
async function assertScreencapAlive(serial: string): Promise<void> {
  const out = await adbShell(serial, "screencap | tail -c +17 | tr -d '\\0' | head -c 1 | wc -c", {
    timeoutMs: 10_000,
  });
  // Match success on "1" specifically: empty output (screencap binary missing,
  // exec-out drained nothing) used to trim to "" which !== "0" and silently
  // returned success — i.e. a broken capture path was reported as healthy.
  // Any non-"1" reading (zero pixels OR no output at all) is a failure.
  if (out.trim() !== "1") {
    await killEmulatorQuietly(serial);
    throw new Error(
      "hot-boot composite not restored: `screencap` returned an all-zero or empty frame. " +
        "Falling back to cold boot so screenshots are usable."
    );
  }
}

async function findSerialByAvdName(avdName: string, deadline: number): Promise<string | null> {
  while (Date.now() < deadline) {
    const devices = await listAndroidDevices().catch(() => []);
    const match = devices.find((d) => d.isEmulator && d.avdName === avdName);
    if (match) return match.serial;
    await new Promise((r) => setTimeout(r, 1_500));
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
  registry: Registry
): Promise<{ platform: "ios"; udid: string; booted: true }> {
  await ensureDep("xcrun");
  await execFileAsync("xcrun", ["simctl", "boot", udid]).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // `simctl boot` errors when the device is already booted — treat as success.
    if (!message.includes("Unable to boot device in current state: Booted")) {
      throw err;
    }
  });
  // `bootstatus -b` blocks until the simulator is fully ready for env setup.
  await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  await registry.resolveService(ndRef.urn, ndRef.options);
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
  emulatorArgs: string[];
  attemptDeadline: number;
  serialsBefore: Set<string>;
  adbRegisterBudgetMs: number;
  deviceReadyBudgetMs: number;
  bootCompletedBudgetMs: number;
}): Promise<{ serial: string }> {
  const child = spawn(EMULATOR_BINARY, params.emulatorArgs, {
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
      await new Promise((r) => setTimeout(r, 1_000));
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
  // Race against earlyExitError so a crash here surfaces with the actual
  // signal/exit-code error, not a misleading "PackageManager did not respond".
  const stage5Racer = createEarlyExitRacer(() => earlyExitError);
  try {
    await Promise.race([
      adbShell(serial, "pm path android", { timeoutMs: 10_000 }),
      stage5Racer.promise,
    ]);
  } catch (err) {
    await killEmulatorQuietly(serial, child);
    if (err instanceof Error && /^emulator binary (exited|terminated)/.test(err.message)) {
      throw err;
    }
    throw new Error(
      `PackageManager did not respond on ${serial} after boot_completed. ` +
        `Emulator has been terminated.`
    );
  } finally {
    stage5Racer.cancel();
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
    coldBoot: boolean;
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
  coldBoot: boolean;
  noWindow: boolean;
  bootTimeoutMs: number;
}): Promise<{
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
  coldBoot: boolean;
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
  coldBoot: boolean;
  noWindow: boolean;
  bootTimeoutMs: number;
}): Promise<{
  platform: "android";
  serial: string;
  avdName: string;
  booted: true;
  coldBoot: boolean;
}> {
  await ensureDep("adb");
  const overallDeadline = Date.now() + params.bootTimeoutMs;

  // Stage 0: validate AVD exists.
  const avds = await listAvds();
  if (avds.length === 0) {
    throw new Error(
      "`emulator -list-avds` returned no AVDs. Install the Android Emulator package or create an AVD via Android Studio or `avdmanager create avd`."
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
  if (!params.coldBoot) {
    const alreadyRunning = existingDevices.find(
      (d) => d.isEmulator && d.avdName === params.avdName && d.state === "device"
    );
    if (alreadyRunning) {
      return {
        platform: "android",
        serial: alreadyRunning.serial,
        avdName: params.avdName,
        booted: true,
        coldBoot: false,
      };
    }
  }
  const serialsBefore = new Set(existingDevices.map((d) => d.serial));

  // Decide whether to try a hot boot. The user can force cold boot explicitly;
  // otherwise we try hot-boot iff a default_boot snapshot exists on disk AND
  // the emulator's own `-check-snapshot-loadable` probe says the metadata is
  // valid. Probe takes ~1-2 s and catches the two most common silent-hang
  // causes: renderer/GPU config drift and `snapshot.pb` metadata corruption.
  let usedColdBoot = params.coldBoot;
  let hotBootFailureReason: string | null = null;
  if (!params.coldBoot) {
    const hasSnapshot = await hasDefaultBootSnapshot(params.avdName);
    if (!hasSnapshot) {
      hotBootFailureReason = "no default_boot snapshot exists";
      usedColdBoot = true;
    } else {
      const probe = await checkSnapshotLoadable(params.avdName, "default_boot");
      if (!probe.loadable) {
        hotBootFailureReason = `-check-snapshot-loadable: ${probe.reason ?? "unknown"}`;
        usedColdBoot = true;
      } else {
        // Hot boot attempt. `-force-snapshot-load` flips the emulator's default
        // "silent fallback to cold boot on load failure" into a loud early exit
        // so ram.bin corruption (which the probe misses) surfaces in seconds
        // rather than hanging for the full overall budget. `-no-snapshot-save`
        // avoids overwriting a working snapshot with state captured after we
        // later force-kill the child from a failure path.
        const hotArgs = ["-avd", params.avdName, "-force-snapshot-load", "-no-snapshot-save"];
        if (params.noWindow) hotArgs.push("-no-window");
        const hotAttemptDeadline = Math.min(overallDeadline, Date.now() + HOT_BOOT_BUDGET_MS);
        try {
          const result = await attemptBoot({
            avdName: params.avdName,
            emulatorArgs: hotArgs,
            attemptDeadline: hotAttemptDeadline,
            serialsBefore,
            // Snapshot restores register with adb within a couple of seconds;
            // a minute-long register wait on the hot path would mask the
            // scenario where load fails and the child silently cold-boots.
            adbRegisterBudgetMs: 30_000,
            deviceReadyBudgetMs: 30_000,
            bootCompletedBudgetMs: 30_000,
          });
          await assertScreencapAlive(result.serial);
          return {
            platform: "android",
            serial: result.serial,
            avdName: params.avdName,
            booted: true,
            coldBoot: false,
          };
        } catch (err) {
          hotBootFailureReason = err instanceof Error ? err.message : String(err);
          usedColdBoot = true;
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
  }

  // Cold boot (either forced by param, or hot-boot fell back).
  const coldArgs = ["-avd", params.avdName, "-no-snapshot-load"];
  if (params.noWindow) coldArgs.push("-no-window");
  let coldResult: { serial: string };
  try {
    coldResult = await attemptBoot({
      avdName: params.avdName,
      emulatorArgs: coldArgs,
      attemptDeadline: overallDeadline,
      serialsBefore,
      adbRegisterBudgetMs: STAGE_BUDGET.adbRegister,
      deviceReadyBudgetMs: STAGE_BUDGET.deviceReady,
      bootCompletedBudgetMs: STAGE_BUDGET.bootCompleted,
    });
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    const suffix = hotBootFailureReason
      ? ` Hot-boot was also attempted and failed (${hotBootFailureReason}).`
      : "";
    throw new Error(
      `${base} Emulator has been terminated so the next boot starts clean.` +
        ` If this keeps happening, wipe the AVD with \`emulator -avd ${params.avdName} -wipe-data\`.${suffix}`
    );
  }

  return {
    platform: "android",
    serial: coldResult.serial,
    avdName: params.avdName,
    booted: true,
    coldBoot: usedColdBoot,
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
      timer = setTimeout(tick, 500);
    };
    timer = setTimeout(tick, 500);
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

// boot-device dispatches internally on `udid` vs `avdName` rather than via
// `dispatchByPlatform` (the helper assumes a single udid input). Capability
// is still declared so the HTTP gate rejects an iOS udid on a host without
// xcrun, etc., and so `list-devices` consumers can rely on uniform metadata.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  return {
    id: "boot-device",
    description: `Start an iOS simulator or launch an Android emulator and wait until it is ready to accept interactions.
Pick the platform by which argument you pass: 'udid' for an iOS simulator from list-devices, or 'avdName' for an Android AVD (a serial is assigned automatically).
Use at the start of a session once you have picked a target.
Returns a tagged payload: { platform: 'ios', udid, booted } or { platform: 'android', serial, avdName, booted, coldBoot }.
Android boots take 2–10 minutes depending on machine and cold/warm state; if any boot stage fails, the tool terminates the emulator it spawned so the next retry starts clean.`,
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const hasUdid = Boolean(params.udid);
      const hasAvd = Boolean(params.avdName);
      if (hasUdid === hasAvd) {
        throw new Error("Provide exactly one of `udid` (iOS) or `avdName` (Android).");
      }
      if (hasUdid) {
        return bootIos(params.udid!, registry);
      }
      return bootAndroid({
        avdName: params.avdName!,
        coldBoot: params.coldBoot ?? false,
        noWindow: params.noWindow ?? false,
        bootTimeoutMs: params.bootTimeoutMs ?? 480_000,
      });
    },
  };
}

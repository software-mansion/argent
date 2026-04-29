import { spawn } from "node:child_process";
import type { PlatformImpl } from "../../../../utils/cross-platform-tool";
import {
  adbShell,
  checkSnapshotLoadable,
  EMULATOR_BINARY,
  hasDefaultBootSnapshot,
  listAndroidDevices,
  listAvds,
  runAdb,
  waitForBootCompleted,
} from "../../../../utils/adb";
import type { BootDeviceParams, BootDeviceResult, BootDeviceServices } from "../types";

// Each stage has its own sub-budget so a hang in one stage cannot consume the
// entire overall budget and a bootTimeoutMs bump doesn't quietly mask a regression.
const STAGE_BUDGET = {
  adbRegister: 60_000, // adb devices sees the serial for this AVD
  deviceReady: 180_000, // adb -s wait-for-device returns (state === "device")
  bootCompleted: 300_000, // sys.boot_completed = 1
} as const;

// Tight budget for a hot boot attempt. A successful hot boot completes well
// under 15 s on fast hardware and under ~45 s on a cold host page cache; the
// 90 s ceiling exists to bound the pathological case where snapshot load
// succeeds but the guest system_server is stuck — without this cap, a silent
// system-server hang would eat the full cold-boot budget before we retry.
const HOT_BOOT_BUDGET_MS = 90_000;

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
  if (out.trim() === "0") {
    await killEmulatorQuietly(serial);
    throw new Error(
      "hot-boot composite not restored: `screencap` returned an all-zero frame. " +
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
  child.on("exit", (code) => {
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
  try {
    await Promise.race([
      runAdb(["-s", serial, "wait-for-device"], {
        timeoutMs: Math.min(
          params.deviceReadyBudgetMs,
          Math.max(1_000, params.attemptDeadline - Date.now())
        ),
      }),
      waitForEarlyExit(() => earlyExitError),
    ]);
  } catch (err) {
    await killEmulatorQuietly(serial, child);
    throw err instanceof Error
      ? err
      : new Error(`adb wait-for-device failed for ${serial}: ${String(err)}.`);
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
  try {
    await adbShell(serial, "pm path android", { timeoutMs: 10_000 });
  } catch {
    await killEmulatorQuietly(serial, child);
    throw new Error(
      `PackageManager did not respond on ${serial} after boot_completed. ` +
        `Emulator has been terminated.`
    );
  }

  return { serial };
}

/**
 * Poll an exit-state getter and reject as soon as it returns non-null.
 * Used to race against a blocking adb call so a detached-emulator crash
 * surfaces as its specific error instead of a generic adb timeout.
 */
function waitForEarlyExit(getExit: () => Error | null): Promise<never> {
  return new Promise((_resolve, reject) => {
    const tick = () => {
      const err = getExit();
      if (err) {
        reject(err);
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}

export const androidImpl: PlatformImpl<BootDeviceServices, BootDeviceParams, BootDeviceResult> = {
  requires: ["adb"],
  handler: async (_services, params, device) => {
    const avdName = device.id;
    const coldBoot = params.coldBoot ?? false;
    const noWindow = params.noWindow ?? false;
    const bootTimeoutMs = params.bootTimeoutMs ?? 480_000;
    const overallDeadline = Date.now() + bootTimeoutMs;

    // Stage 0: validate AVD exists.
    const avds = await listAvds();
    if (avds.length === 0) {
      throw new Error(
        "`emulator -list-avds` returned no AVDs. Install the Android Emulator package or create an AVD via Android Studio or `avdmanager create avd`."
      );
    }
    if (!avds.some((a) => a.name === avdName)) {
      throw new Error(
        `AVD "${avdName}" not found. Available: ${avds.map((a) => a.name).join(", ")}.`
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
    if (!coldBoot) {
      const alreadyRunning = existingDevices.find(
        (d) => d.isEmulator && d.avdName === avdName && d.state === "device"
      );
      if (alreadyRunning) {
        return {
          platform: "android",
          serial: alreadyRunning.serial,
          avdName,
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
    let usedColdBoot = coldBoot;
    let hotBootFailureReason: string | null = null;
    if (!coldBoot) {
      const hasSnapshot = await hasDefaultBootSnapshot(avdName);
      if (!hasSnapshot) {
        hotBootFailureReason = "no default_boot snapshot exists";
        usedColdBoot = true;
      } else {
        const probe = await checkSnapshotLoadable(avdName, "default_boot");
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
          const hotArgs = ["-avd", avdName, "-force-snapshot-load", "-no-snapshot-save"];
          if (noWindow) hotArgs.push("-no-window");
          const hotAttemptDeadline = Math.min(overallDeadline, Date.now() + HOT_BOOT_BUDGET_MS);
          try {
            const result = await attemptBoot({
              avdName,
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
              avdName,
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
    const coldArgs = ["-avd", avdName, "-no-snapshot-load"];
    if (noWindow) coldArgs.push("-no-window");
    let coldResult: { serial: string };
    try {
      coldResult = await attemptBoot({
        avdName,
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
          ` If this keeps happening, wipe the AVD with \`emulator -avd ${avdName} -wipe-data\`.${suffix}`
      );
    }

    return {
      platform: "android",
      serial: coldResult.serial,
      avdName,
      booted: true,
      coldBoot: usedColdBoot,
    };
  },
};

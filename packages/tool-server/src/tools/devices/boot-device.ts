import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import {
  adbShell,
  emulatorBinaryName,
  listAndroidDevices,
  listAvds,
  runAdb,
  waitForBootCompleted,
} from "../../utils/adb";
import { warmDeviceCache } from "../../utils/platform-detect";
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
      "Android-only: skip the AVD snapshot and cold-boot. Defaults to true for reliability — corrupt snapshots are the leading cause of silent boot hangs. Ignored on iOS."
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

async function killEmulatorQuietly(serial: string | null): Promise<void> {
  if (serial) {
    await runAdb(["-s", serial, "emu", "kill"], { timeoutMs: 5_000 }).catch(() => {});
  }
}

// Best-effort termination for an emulator that was spawned detached + unref'd
// but never registered with adb — in that state `adb emu kill` has no serial
// to target, so we must signal the ChildProcess directly. SIGTERM gives the
// emulator a chance to flush its snapshot; a follow-up SIGKILL after a short
// grace window handles the "ignored SIGTERM" case.
function killDetachedEmulator(child: import("node:child_process").ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, 2_000).unref();
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
  const { stdout } = await runAdb(["devices"]).catch(() => ({ stdout: "", stderr: "" }));
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
  await registry.resolveService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`);
  await execFileAsync("defaults", [
    "write",
    "com.apple.iphonesimulator",
    "CurrentDeviceUDID",
    udid,
  ]);
  await execFileAsync("open", ["-a", "Simulator.app"]);
  warmDeviceCache([{ udid, platform: "ios" }]);
  return { platform: "ios", udid, booted: true };
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
  const serialsBefore = new Set((await listAndroidDevices().catch(() => [])).map((d) => d.serial));

  // Stage 1: spawn emulator.
  const emulatorArgs = ["-avd", params.avdName];
  if (params.coldBoot) emulatorArgs.push("-no-snapshot-load");
  if (params.noWindow) emulatorArgs.push("-no-window");

  const child = spawn(emulatorBinaryName(), emulatorArgs, {
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
  const adbDeadline = Math.min(overallDeadline, Date.now() + STAGE_BUDGET.adbRegister);
  try {
    while (Date.now() < adbDeadline) {
      if (earlyExitError) throw earlyExitError;
      const newSerials = await listNewEmulatorSerials(serialsBefore);
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
    // Covers earlyExitError thrown from inside the loop — still need to
    // reap the detached child if it is somehow alive.
    killDetachedEmulator(child);
    throw err;
  }
  if (!serial) {
    if (earlyExitError) {
      killDetachedEmulator(child);
      throw earlyExitError;
    }
    // The emulator binary is running detached but never registered with adb.
    // `killEmulatorQuietly(null)` is a no-op here (no serial to target), so
    // we must signal the child process directly — otherwise the emulator is
    // orphaned and the user has to find + kill the PID by hand.
    killDetachedEmulator(child);
    throw new Error(
      `Emulator "${params.avdName}" did not register within ${STAGE_BUDGET.adbRegister / 1000}s. ` +
        `The emulator process has been terminated. ` +
        `Check that the Android SDK is on PATH and that no other emulator is already using the assigned port.`
    );
  }

  // Stage 3: wait-for-device (tcp socket up). Race against earlyExitError so
  // an emulator crash here is surfaced immediately instead of blocking for
  // the full 180 s budget and then throwing a generic timeout.
  try {
    await Promise.race([
      runAdb(["-s", serial, "wait-for-device"], {
        timeoutMs: Math.min(
          STAGE_BUDGET.deviceReady,
          Math.max(1_000, overallDeadline - Date.now())
        ),
      }),
      waitForEarlyExit(() => earlyExitError),
    ]);
  } catch (err) {
    await killEmulatorQuietly(serial);
    throw err instanceof Error
      ? err
      : new Error(`adb wait-for-device failed for ${serial}: ${String(err)}.`);
  }

  // Stage 4: sys.boot_completed = 1.
  const bootBudget = Math.max(
    10_000,
    Math.min(STAGE_BUDGET.bootCompleted, overallDeadline - Date.now())
  );
  try {
    await waitForBootCompleted(serial, bootBudget, {
      shouldAbort: () => earlyExitError,
    });
  } catch (err) {
    await killEmulatorQuietly(serial);
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} ` +
        `Emulator has been terminated so the next boot starts clean. ` +
        `If this keeps happening, the AVD's snapshot may be corrupt — the tool already cold-boots by default, ` +
        `but you can also manually wipe user data with \`emulator -avd ${params.avdName} -wipe-data\` from a shell.`
    );
  }

  // Stage 5: PackageManagerService sanity probe — protects callers from a
  // race where boot_completed fires but `am start` would still 500 for 10-30s.
  try {
    await adbShell(serial, "pm path android", { timeoutMs: 10_000 });
  } catch {
    await killEmulatorQuietly(serial);
    throw new Error(
      `PackageManager did not respond on ${serial} after boot_completed. ` +
        `Emulator has been terminated. Retry the call.`
    );
  }

  // Warm the classify cache so the interaction tool the caller invokes next
  // (launch-app / describe / ...) is a cache hit and doesn't re-run the adb
  // list lookup just to confirm what we already know.
  warmDeviceCache([{ udid: serial, platform: "android" }]);

  return {
    platform: "android",
    serial,
    avdName: params.avdName,
    booted: true,
    coldBoot: params.coldBoot,
  };
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

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  return {
    id: "boot-device",
    description: `Start an iOS simulator or Android emulator and wait until it is ready to accept interactions.
Use when a target picked from list-devices is still in a shutdown/offline state, or to launch a fresh Android emulator by AVD name. Pass 'udid' for an iOS simulator or 'avdName' for Android (a serial is assigned automatically).
Returns a tagged payload: { platform: 'ios', udid, booted } or { platform: 'android', serial, avdName, booted, coldBoot }. Android boots take 2–10 minutes depending on cold/warm state.
Fails when the AVD name does not exist, when a boot stage times out, or when the required platform developer tooling is missing; on failure the spawned emulator is terminated so the next retry starts clean.`,
    zodSchema,
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
        coldBoot: params.coldBoot ?? true,
        noWindow: params.noWindow ?? false,
        bootTimeoutMs: params.bootTimeoutMs ?? 480_000,
      });
    },
  };
}

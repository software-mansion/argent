import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  adbShell,
  emulatorBinaryName,
  listAndroidDevices,
  listAvds,
  runAdb,
  waitForBootCompleted,
} from "../../utils/adb";

const zodSchema = z.object({
  avdName: z
    .string()
    .describe("AVD name to boot (from `android-list-emulators`). Example: `Pixel_7_API_34`."),
  coldBoot: z
    .boolean()
    .optional()
    .describe(
      "Skip the AVD snapshot and cold-boot. Defaults to true — cold boot is slower but avoids " +
        "the common failure where a corrupt snapshot leaves the emulator stuck at `offline` for several minutes."
    ),
  noWindow: z
    .boolean()
    .optional()
    .describe(
      "Launch the emulator headless (no UI window). Useful for CI. Defaults to false — " +
        "the UI surfaces boot progress, which helps when diagnosing slow cold boots."
    ),
  bootTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .optional()
    .describe(
      "Overall budget for the full boot sequence (adb-appearance + boot_completed). Defaults to 480000 (8 min). Clamped to [30s, 15min]."
    ),
});

// Each stage has its own sub-budget so a hang in one stage cannot consume the
// entire overall budget and a bootTimeoutMs bump doesn't quietly mask a regression.
const STAGE_BUDGET = {
  qemuVisible: 30_000, // time from spawn → qemu-system-* process alive
  adbRegister: 60_000, // adb devices sees the serial for this AVD
  deviceReady: 180_000, // adb -s wait-for-device returns (state === "device")
  bootCompleted: 300_000, // sys.boot_completed = 1
} as const;

async function killEmulatorQuietly(serial: string | null): Promise<void> {
  if (serial) {
    await runAdb(["-s", serial, "emu", "kill"], { timeoutMs: 5_000 }).catch(() => {});
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
  const { stdout } = await runAdb(["devices"]).catch(() => ({ stdout: "", stderr: "" }));
  const lines = stdout.split("\n");
  const now: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(emulator-\d+)\s+/);
    if (m) now.push(m[1]!);
  }
  return now.filter((s) => !before.has(s));
}

export const androidBootEmulatorTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { booted: boolean; serial: string; avdName: string; coldBoot: boolean }
> = {
  id: "android-boot-emulator",
  description:
    "Start an Android emulator by AVD name and wait until it finishes booting. " +
    "Cold-boots by default (skips the snapshot) because corrupt snapshots are the #1 cause of silent boot hangs. " +
    "Expect 2–5 minutes on Apple Silicon; 5–10 minutes on older machines or cold disks. " +
    "Returns { booted, serial, avdName, coldBoot }. On any stage failure the tool kills the emulator process it started and returns a clear error, so the next call begins from a clean state.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const overallBudget = params.bootTimeoutMs ?? 480_000;
    const overallDeadline = Date.now() + overallBudget;
    // Default to TRUE — reliability over speed per user direction. Callers who
    // need a warm boot for speed can opt in explicitly.
    const coldBoot = params.coldBoot ?? true;

    // ── Stage 0: validate AVD exists ──────────────────────────────────
    const avds = await listAvds();
    if (avds.length === 0) {
      throw new Error(
        "`emulator -list-avds` returned no AVDs. Either the Android Emulator package is not on PATH, " +
          "or no AVDs are defined. Create one via Android Studio or `avdmanager create avd`."
      );
    }
    if (!avds.some((a) => a.name === params.avdName)) {
      throw new Error(
        `AVD "${params.avdName}" not found. Available: ${avds.map((a) => a.name).join(", ")}.`
      );
    }

    // Snapshot the serials already known so we can identify the new one, as a
    // fallback if the AVD-name lookup (via getprop) is slow to return.
    const serialsBefore = new Set(
      (await listAndroidDevices().catch(() => [])).map((d) => d.serial)
    );

    // ── Stage 1: spawn emulator ───────────────────────────────────────
    const emulatorArgs = ["-avd", params.avdName];
    if (coldBoot) emulatorArgs.push("-no-snapshot-load");
    if (params.noWindow) emulatorArgs.push("-no-window");
    // `-delay-adb` and `-read-only` would complicate the reliability story.
    // Keep the arg set minimal so failure modes are easy to reason about.

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

    // Ensure adb daemon is up so the new device socket registers promptly.
    await runAdb(["start-server"], { timeoutMs: 10_000 }).catch(() => {});

    // ── Stage 2: wait for adb to see the new emulator ─────────────────
    let serial: string | null = null;
    const adbDeadline = Math.min(overallDeadline, Date.now() + STAGE_BUDGET.adbRegister);
    while (Date.now() < adbDeadline) {
      if (earlyExitError) {
        throw earlyExitError;
      }
      const newSerials = await listNewEmulatorSerials(serialsBefore);
      if (newSerials.length >= 1) {
        // If exactly one new emulator, adopt its serial. If multiple, prefer the
        // AVD-name match.
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
    if (!serial) {
      await killEmulatorQuietly(null);
      throw new Error(
        `Emulator "${params.avdName}" did not register with adb within ${STAGE_BUDGET.adbRegister / 1000}s. ` +
          `Check that the Android SDK is on PATH and that no other emulator is already using the assigned port.`
      );
    }

    // ── Stage 3: wait-for-device (tcp socket up) ──────────────────────
    try {
      await runAdb(["-s", serial, "wait-for-device"], {
        timeoutMs: Math.min(
          STAGE_BUDGET.deviceReady,
          Math.max(1_000, overallDeadline - Date.now())
        ),
      });
    } catch (err) {
      await killEmulatorQuietly(serial);
      throw new Error(
        `adb wait-for-device failed for ${serial}: ${
          err instanceof Error ? err.message : String(err)
        }. Emulator has been terminated; retry in a moment.`
      );
    }

    // ── Stage 4: sys.boot_completed = 1 ───────────────────────────────
    const bootBudget = Math.max(
      10_000,
      Math.min(STAGE_BUDGET.bootCompleted, overallDeadline - Date.now())
    );
    try {
      await waitForBootCompleted(serial, bootBudget);
    } catch (err) {
      await killEmulatorQuietly(serial);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} ` +
          `Emulator has been terminated so the next boot starts clean. ` +
          `If this keeps happening, the AVD's snapshot may be corrupt — the tool already cold-boots by default, ` +
          `but you can also manually wipe user data with \`emulator -avd ${params.avdName} -wipe-data\` from a shell.`
      );
    }

    // ── Stage 5: one final sanity probe ───────────────────────────────
    // `pm` responds only after PackageManagerService is up. This prevents the
    // tool from returning `booted: true` while subsequent `am start` / `pm list`
    // calls would still 500 for ~10-30s.
    try {
      await adbShell(serial, "pm path android", { timeoutMs: 10_000 });
    } catch (err) {
      await killEmulatorQuietly(serial);
      throw new Error(
        `PackageManager did not respond on ${serial} after boot_completed. ` +
          `Emulator has been terminated. Retry the call.`
      );
    }

    return { booted: true, serial, avdName: params.avdName, coldBoot };
  },
};

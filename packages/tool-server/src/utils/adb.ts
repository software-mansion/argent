import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AdbRunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run `adb` directly. Callers that target a single device must pass `-s <serial>`
 * themselves via `args` — `runAdb` does not inject it, so a serial-less call
 * will hit whichever device `ANDROID_SERIAL` / the default heuristic picks.
 */
export async function runAdb(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<AdbRunResult> {
  const { stdout, stderr } = await execFileAsync("adb", args, {
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf-8",
  });
  return { stdout, stderr };
}

/**
 * Run `adb` and return stdout as a Buffer — needed for binary payloads
 * (screencap PNG bytes, uiautomator dump, etc.) where utf-8 decoding corrupts
 * the stream.
 */
export async function runAdbBinary(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<Buffer> {
  const { stdout } = await execFileAsync("adb", args, {
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}

/** `adb -s <serial> shell <shellCommand>` with the shell command passed as a single argv entry. */
export async function adbShell(
  serial: string,
  shellCommand: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { stdout } = await runAdb(["-s", serial, "shell", shellCommand], options);
  return stdout;
}

/** `adb -s <serial> exec-out <shellCommand>` — preserves stdout bytes for binary payloads. */
export async function adbExecOutBinary(
  serial: string,
  shellCommand: string,
  options: { timeoutMs?: number } = {}
): Promise<Buffer> {
  return runAdbBinary(["-s", serial, "exec-out", shellCommand], options);
}

export interface AndroidDevice {
  serial: string;
  state: string;
  isEmulator: boolean;
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
}

/**
 * Parse the tab-separated output of `adb devices -l` into a list. Unauthorized
 * and offline entries are kept in the list so the caller can surface them to the
 * user — filter by `state === "device"` for ready-to-use devices.
 */
export function parseAdbDevices(stdout: string): Array<{ serial: string; state: string }> {
  const devices: Array<{ serial: string; state: string }> = [];
  const lines = stdout.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices")) continue;
    // Format: "<serial>\t<state>" optionally followed by key:value pairs
    const match = line.match(/^(\S+)\s+(\S+)/);
    if (!match) continue;
    devices.push({ serial: match[1]!, state: match[2]! });
  }
  return devices;
}

/**
 * Light-weight listing used by `classifyDevice` and anywhere else that only
 * needs to know which serials exist. Skips the per-device getprop round-trips
 * so a cold classify is one `adb devices` call, not 1 + 3N shell-outs.
 */
export async function listAndroidSerials(): Promise<Array<{ serial: string; state: string }>> {
  const { stdout } = await runAdb(["devices"]);
  return parseAdbDevices(stdout);
}

/**
 * Resolve the AVD name of a running emulator. The property moved from
 * `ro.kernel.qemu.avd_name` to `ro.boot.qemu.avd_name` in emulator release 30
 * (Android 11+); we probe the newer one first and fall back to the legacy
 * name so both old and new images work.
 */
async function readAvdName(serial: string): Promise<string | null> {
  const modern = await adbShell(serial, "getprop ro.boot.qemu.avd_name").catch(() => "");
  if (modern.trim()) return modern.trim();
  const legacy = await adbShell(serial, "getprop ro.kernel.qemu.avd_name").catch(() => "");
  return legacy.trim() || null;
}

/**
 * List all Android devices + emulators known to adb, enriched with model,
 * AVD name, and SDK level via `getprop`. Use `listAndroidSerials` when you
 * only need the state-scoped serial list — it avoids the extra round-trips.
 */
export async function listAndroidDevices(): Promise<AndroidDevice[]> {
  const basic = await listAndroidSerials();

  const enriched = await Promise.all(
    basic.map(async (d): Promise<AndroidDevice> => {
      if (d.state !== "device") {
        return {
          serial: d.serial,
          state: d.state,
          isEmulator: d.serial.startsWith("emulator-"),
          model: null,
          avdName: null,
          sdkLevel: null,
        };
      }
      const [model, sdk, avd] = await Promise.all([
        adbShell(d.serial, "getprop ro.product.model").catch(() => ""),
        adbShell(d.serial, "getprop ro.build.version.sdk").catch(() => ""),
        readAvdName(d.serial),
      ]);
      const sdkLevel = parseInt(sdk.trim(), 10);
      return {
        serial: d.serial,
        state: d.state,
        isEmulator: d.serial.startsWith("emulator-"),
        model: model.trim() || null,
        avdName: avd,
        sdkLevel: Number.isFinite(sdkLevel) ? sdkLevel : null,
      };
    })
  );
  return enriched;
}

/**
 * Block until a device is fully booted. `adb wait-for-device` only waits for the
 * daemon connection; `sys.boot_completed=1` is the Android-canonical "fully booted"
 * signal that package manager + activity manager are ready to receive commands.
 */
export async function waitForBootCompleted(
  serial: string,
  timeoutMs = 120_000,
  options: { shouldAbort?: () => Error | null } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Surface emulator-crash errors immediately rather than blocking for the
    // full boot budget after the underlying process is already dead.
    const abortError = options.shouldAbort?.();
    if (abortError) throw abortError;
    try {
      const out = await adbShell(serial, "getprop sys.boot_completed", { timeoutMs: 3_000 });
      if (out.trim() === "1") return;
    } catch {
      // Device may be mid-boot; swallow and retry
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out waiting for ${serial} to finish booting`);
}

export interface AvdInfo {
  name: string;
}

// AVD names created by `avdmanager create avd` / Android Studio are limited
// to letters, digits, `.`, `_`, and `-` (no whitespace, no path separators).
// The emulator binary also prints diagnostics like `INFO    | ...` and
// `HAX is working and emulator runs in fast virt mode.` on the same stream;
// matching valid-AVD-shape accepts real names while rejecting those lines
// even if they happen to start with INFO or HAX.
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** List available AVDs via `emulator -list-avds`. Returns [] if emulator binary is unavailable. */
export async function listAvds(): Promise<AvdInfo[]> {
  try {
    const { stdout } = await execFileAsync("emulator", ["-list-avds"], { timeout: 5_000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && AVD_NAME_PATTERN.test(l))
      .map((name) => ({ name }));
  } catch {
    return [];
  }
}

/** Resolve the `emulator` binary path so we can spawn it detached. */
export function emulatorBinaryName(): string {
  return "emulator";
}

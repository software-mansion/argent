import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAndroidBinary } from "./android-binary";

const execFileAsync = promisify(execFile);

// `runAdb` / `runAdbBinary` / `listAvds` / `checkSnapshotLoadable` all used to
// call `execFileAsync("adb"|"emulator", ...)` directly, which only honors PATH.
// Tools that declare `requires: ["adb"]` (or `["emulator"]`) preflight via
// `ensureDep`, which now consults `resolveAndroidBinary` and surfaces a 424
// with the install hint when neither PATH nor `$ANDROID_HOME` resolves the
// binary — so by the time these helpers run, the resolver returns a real
// path. The thrown messages here are a safety net for direct callers that
// skipped the preflight (unit tests, internal scripts, future code paths)
// rather than the primary user-facing diagnostic.
async function resolveAdbOrThrow(): Promise<string> {
  const path = await resolveAndroidBinary("adb");
  if (!path) {
    throw new Error(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools`. " +
        "Install Android SDK Platform Tools or set `$ANDROID_HOME` to your SDK root."
    );
  }
  return path;
}

export async function resolveEmulatorOrThrow(): Promise<string> {
  const path = await resolveAndroidBinary("emulator");
  if (!path) {
    throw new Error(
      "`emulator` not found on PATH or under `$ANDROID_HOME/emulator`. " +
        "Install the Android Emulator package or set `$ANDROID_HOME` to your SDK root."
    );
  }
  return path;
}

export interface AdbRunResult {
  stdout: string;
  stderr: string;
}

// On timeout, Node's execFile default kill signal is SIGTERM, which an `adb`
// process blocked on a hung daemon can ignore — leaving the parent waiting
// past the deadline. SIGKILL guarantees the child is reaped at the timeout
// boundary so callers' overall budgets actually hold.
const ADB_KILL_SIGNAL = "SIGKILL" as const;

function describeAdbFailure(args: string[], err: unknown): Error {
  // Prefer adb's own stderr/stdout — that's the actionable diagnostic
  // ("device offline", etc.). When both are empty (timeout-SIGKILL, daemon
  // hang) fall back to the bare message + signal/killed/code so the failure
  // mode is still identifiable instead of a tautological "Command failed".
  const e = err as {
    code?: string | number | null;
    signal?: string | null;
    killed?: boolean;
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  const argv = args.join(" ");
  const ioDetail = (e.stderr ?? "").trim() || (e.stdout ?? "").trim();
  if (ioDetail) return new Error(`adb ${argv} failed: ${ioDetail}`);
  const meta: string[] = [];
  if (e.killed) meta.push("killed=true");
  if (e.signal) meta.push(`signal=${e.signal}`);
  if (e.code) meta.push(`code=${e.code}`);
  const baseMsg = (e.message ?? String(err)).trim();
  const suffix = meta.length ? ` (${meta.join(" ")})` : "";
  return new Error(`adb ${argv} failed: ${baseMsg}${suffix}`);
}

/**
 * Run `adb` directly. Callers that target a single device must pass `-s <serial>`
 * themselves via `args` — `runAdb` does not inject it, so a serial-less call
 * will hit whichever device `ANDROID_SERIAL` / the default heuristic picks.
 *
 * On non-zero exit or timeout, throws an Error whose message includes the
 * actual `adb` stderr (or stdout) instead of the bare "Command failed".
 */
export async function runAdb(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<AdbRunResult> {
  const adbPath = await resolveAdbOrThrow();
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, {
      timeout: options.timeoutMs ?? 30_000,
      killSignal: ADB_KILL_SIGNAL,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
    });
    return { stdout, stderr };
  } catch (err) {
    throw describeAdbFailure(args, err);
  }
}

/**
 * Run `adb` and return stdout as a Buffer — needed for binary payloads
 * (screencap PNG bytes, uiautomator dump, etc.) where utf-8 decoding corrupts
 * the stream.
 */
async function runAdbBinary(args: string[], options: { timeoutMs?: number } = {}): Promise<Buffer> {
  const adbPath = await resolveAdbOrThrow();
  try {
    const { stdout } = await execFileAsync(adbPath, args, {
      timeout: options.timeoutMs ?? 30_000,
      killSignal: ADB_KILL_SIGNAL,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout as unknown as Buffer;
  } catch (err) {
    throw describeAdbFailure(args, err);
  }
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

// Set of states `adb devices` actually emits — filtering to this set rejects
// daemon-startup banner lines like `* daemon not running; starting now …` /
// `* daemon started successfully *`, which the loose `\S+ \s+ \S+` regex
// otherwise parses as `serial="*", state="daemon"` (or similar) and feeds
// into downstream loops as a phantom device.
const ADB_DEVICE_STATES = new Set([
  "device",
  "offline",
  "unauthorized",
  "authorizing",
  "connecting",
  "no",
  "recovery",
  "sideload",
  "bootloader",
  "host",
  "rescue",
]);

/**
 * Parse the tab-separated output of `adb devices` (or `adb devices -l`) into a
 * list. Unauthorized and offline entries are kept in the list so the caller
 * can surface them to the user — filter by `state === "device"` for
 * ready-to-use devices. Daemon-startup banner lines (the `* daemon …` ones
 * adb prints to the same stream when it had to spawn its background server)
 * are skipped.
 */
export function parseAdbDevices(stdout: string): Array<{ serial: string; state: string }> {
  const devices: Array<{ serial: string; state: string }> = [];
  const lines = stdout.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    // Format: "<serial>\t<state>" optionally followed by key:value pairs
    const match = line.match(/^(\S+)\s+(\S+)/);
    if (!match) continue;
    const state = match[2]!;
    if (!ADB_DEVICE_STATES.has(state)) continue;
    devices.push({ serial: match[1]!, state });
  }
  return devices;
}

/**
 * Light-weight listing for callers that only need which serials exist.
 * Skips the per-device getprop round-trips so the call is one `adb devices`
 * shell-out, not 1 + 3N. Used by `listAndroidDevices` as the first hop before
 * it enriches each entry.
 */
async function listAndroidSerials(): Promise<Array<{ serial: string; state: string }>> {
  const { stdout } = await runAdb(["devices"]);
  return parseAdbDevices(stdout);
}

// Short timeout for enrichment getprops. The default (30 s) is fine for an
// interactive call against a healthy device, but `listAndroidDevices` is on
// the hot path of the boot loop — a single mid-attach device can stall the
// stage budget for 30 s × 3 getprops = the entire adb-register window. 5 s
// is plenty for a getprop on any responsive device.
const ENRICH_TIMEOUT_MS = 5_000;

/**
 * Resolve the AVD name of a running emulator. The property moved from
 * `ro.kernel.qemu.avd_name` to `ro.boot.qemu.avd_name` in emulator release 30
 * (Android 11+); we probe the newer one first and fall back to the legacy
 * name so both old and new images work.
 */
async function readAvdName(serial: string): Promise<string | null> {
  const modern = await adbShell(serial, "getprop ro.boot.qemu.avd_name", {
    timeoutMs: ENRICH_TIMEOUT_MS,
  }).catch(() => "");
  if (modern.trim()) return modern.trim();
  const legacy = await adbShell(serial, "getprop ro.kernel.qemu.avd_name", {
    timeoutMs: ENRICH_TIMEOUT_MS,
  }).catch(() => "");
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
        adbShell(d.serial, "getprop ro.product.model", { timeoutMs: ENRICH_TIMEOUT_MS }).catch(
          () => ""
        ),
        adbShell(d.serial, "getprop ro.build.version.sdk", { timeoutMs: ENRICH_TIMEOUT_MS }).catch(
          () => ""
        ),
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

// Errors from `adb shell` that mean the device is in a state no boot wait can
// fix. Returning generically and timing out wastes the full budget and hides
// the actionable cause. These patterns match adb stderr (now surfaced through
// runAdb's rewrapped errors) for the named conditions.
//
// adb's real format includes the offending serial in single quotes between
// `device` and the verdict, e.g. `error: device 'emulator-5554' not found` or
// `error: device 'emulator-5554' offline`. The optional `(?: '[^']*')?` group
// tolerates that quoted serial without requiring it, so both adb's real output
// and serial-less paraphrases match.
const TERMINAL_ADB_ERROR_PATTERNS: RegExp[] = [
  /device(?: '[^']*')? unauthorized/i,
  /device(?: '[^']*')? not found/i,
  /no devices\/emulators found/i,
  /device(?: '[^']*')? offline/i,
];

function isTerminalAdbError(message: string): boolean {
  return TERMINAL_ADB_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Block until a device is fully booted. `adb wait-for-device` only waits for the
 * daemon connection; `sys.boot_completed=1` is the Android-canonical "fully booted"
 * signal that package manager + activity manager are ready to receive commands.
 *
 * Mid-boot getprop failures (the device is still coming up, the shell isn't
 * ready, the daemon is reconnecting) are swallowed and retried. Terminal
 * errors (device unauthorized, offline, not found) are NOT — they mean the
 * caller needs to take action, and waiting another 2 minutes only hides
 * what's wrong.
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTerminalAdbError(message)) {
        throw new Error(
          `Cannot wait for ${serial} to boot — adb reports the device is in a terminal state: ${message}.` +
            ` Authorise the device, reconnect it, or pick a different target.`
        );
      }
      // Otherwise: device may be mid-boot; swallow and retry.
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

/**
 * List available AVDs via `emulator -list-avds`. Returns [] if the emulator
 * binary is unavailable on the host. Callers that need to distinguish "no
 * emulator binary" from "emulator binary present but zero AVDs" should
 * preflight via `ensureDep("emulator")` first — that surfaces a 424 with the
 * install hint when the resolver can't find the binary, while a genuinely
 * empty AVD list still returns `[]`.
 */
export async function listAvds(): Promise<AvdInfo[]> {
  const emulatorPath = await resolveAndroidBinary("emulator");
  if (!emulatorPath) return [];
  try {
    const { stdout } = await execFileAsync(emulatorPath, ["-list-avds"], { timeout: 5_000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && AVD_NAME_PATTERN.test(l))
      .map((name) => ({ name }));
  } catch {
    return [];
  }
}

/**
 * Result of probing a named snapshot with `emulator -check-snapshot-loadable`.
 *
 * `loadable === true` is necessary but NOT sufficient for a successful hot
 * boot: the probe validates metadata (snapshot.pb, compatible.pb, hardware.ini)
 * and renderer compatibility, but not the integrity of ram.bin. A `ram.bin`
 * corrupted by a partial save or a host OOM still returns `Loadable` here and
 * later crashes the QEMU child with `std::bad_alloc`. Pair this probe with
 * `-force-snapshot-load` in the boot spawn and a tight deadline to catch the
 * residual failure cases loudly instead of letting them silently fall back to
 * a full cold boot.
 */
export interface SnapshotProbeResult {
  loadable: boolean;
  reason: string | null;
}

export async function checkSnapshotLoadable(
  avdName: string,
  snapshotName = "default_boot",
  options: { timeoutMs?: number; extraArgs?: readonly string[] } = {}
): Promise<SnapshotProbeResult> {
  try {
    const emulatorPath = await resolveEmulatorOrThrow();
    // Renderer-affecting flags (`-gpu auto`, future `-accel`, etc.) MUST match
    // the args we will pass to the actual hot-boot spawn, otherwise the probe
    // resolves a different renderer than the boot will and reports `Not
    // loadable | Reason: different renderer configured` for a snapshot the
    // boot would have happily loaded. That false-negative routes every hot
    // boot through the cold-boot fallback — the exact symptom this whole PR
    // is trying to kill. Caller is responsible for handing us the same flags
    // it'll use on the boot spawn; see boot-device.ts:RENDERER_ARGS.
    const args = [
      "-avd",
      avdName,
      ...(options.extraArgs ?? []),
      "-check-snapshot-loadable",
      snapshotName,
    ];
    const { stdout } = await execFileAsync(emulatorPath, args, {
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const tail = stdout.split("\n").slice(-6).join("\n");
    // The emulator emits an informational "WARNING | change of renderer
    // detected." whenever `hardware.ini` and `emu-launch-params.txt` disagree
    // (e.g. `hw.gpu.mode=auto` in config.ini vs the resolved `swangle_indirect`
    // recorded on save). It is noise, not a failure signal — actual
    // incompatibility surfaces as a populated `Reason:` with no `Loadable`
    // line (e.g. "snapshot was created with gfxstream=1, but this emulator has
    // gfxstream=0"). The final `Loadable` line is the emulator's authoritative
    // verdict; trust it.
    if (/(^|\n)\s*Loadable\s*(\n|$)/.test(tail)) return { loadable: true, reason: null };
    const reasonMatch = tail.match(/Reason:\s*(.+)/);
    return { loadable: false, reason: reasonMatch?.[1]?.trim() ?? "unknown" };
  } catch (err) {
    return {
      loadable: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : "probe failed",
    };
  }
}

/**
 * Candidate AVD-root directories, in the priority order the Android emulator
 * binary itself uses (see `external/qemu/android/android-emu/android/avd/util.cpp`):
 *
 *   1. `$ANDROID_USER_HOME/avd`            — current Studio convention (≥ 4.2)
 *   2. `$ANDROID_AVD_HOME`                 — explicit override (files live directly here)
 *   3. `$XDG_CONFIG_HOME/Android/avd`      — Linux XDG convention
 *   4. `$ANDROID_SDK_HOME/.android/avd`    — legacy env
 *   5. `$HOME/.android/avd`                — default
 *
 * Mirroring the binary's order is what lets argent find AVDs on Linux setups
 * where Studio defaults to `$ANDROID_USER_HOME` or `$XDG_CONFIG_HOME` instead
 * of `$HOME` — exactly the configurations where the old `$HOME`-only lookup
 * silently returned false and forced a cold boot every time.
 */
function avdRootCandidates(): string[] {
  const home = process.env.HOME ?? "";
  const candidates: Array<string | null | undefined> = [
    process.env.ANDROID_USER_HOME ? `${process.env.ANDROID_USER_HOME}/avd` : null,
    process.env.ANDROID_AVD_HOME,
    process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/Android/avd` : null,
    process.env.ANDROID_SDK_HOME ? `${process.env.ANDROID_SDK_HOME}/.android/avd` : null,
    home ? `${home}/.android/avd` : null,
  ];
  return candidates.filter((p): p is string => Boolean(p && p.startsWith("/")));
}

/**
 * Resolve the absolute path of an AVD's `.avd` folder by reading its `.ini`
 * file. The `path=` line inside `<root>/<name>.ini` is the authoritative
 * source — the `.avd` folder can live anywhere (Studio lets users move AVDs
 * onto a faster disk; snap-installed Studio on Linux puts them under
 * `~/snap/android-studio/...`). The convention `<root>/<name>.avd` is just
 * the default; trusting it for the snapshot lookup mis-targets every AVD that
 * has been relocated, which is the second class of "cold boot every time"
 * symptom on Linux behind the mtime-skew bug.
 *
 * Returns null if no `<name>.ini` is found in any candidate root.
 */
export async function resolveAvdPath(avdName: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  for (const root of avdRootCandidates()) {
    try {
      const ini = await readFile(`${root}/${avdName}.ini`, "utf-8");
      const match = ini.match(/^path\s*=\s*(.+?)\s*$/m);
      if (!match || !match[1]) continue;
      // Trim again — the non-greedy `(.+?)` plus greedy `\s*$` strips most
      // trailing whitespace, but a `path=   ` (whitespace-only value) still
      // captures a single space because `(.+?)` is forced to match ≥1 char.
      // Skip that, plus any non-absolute path: the emulator binary always
      // writes an absolute `path=` and a relative one would resolve against
      // `process.cwd()` here, silently mis-locating snapshots when callers
      // are invoked from outside the project root.
      const trimmed = match[1].trim();
      if (!trimmed.startsWith("/")) continue;
      return trimmed;
    } catch {
      // .ini missing or unreadable in this root; try the next one
    }
  }
  return null;
}

/**
 * True iff a usable `default_boot` snapshot exists on disk for this AVD.
 *
 * Cheap filesystem pre-filter: the emulator's own `-snapshot-list` requires
 * spawning the binary, which is the hang we are trying to avoid up-front.
 *
 * The check is intentionally lenient: `ram.bin` exists and is non-empty, and
 * `snapshot.pb` exists. That is enough because:
 *
 *   - The `-check-snapshot-loadable` probe (called after this returns true)
 *     validates metadata + renderer compatibility before we commit to a
 *     hot-boot spawn.
 *   - The hot-boot spawn passes `-force-snapshot-load`, so a truncated or
 *     corrupt `ram.bin` produces a loud early child-exit instead of a silent
 *     qemu fall-through to cold boot — caught by `attemptBoot`'s
 *     `earlyExitError` race and recovered via the cold-boot fallback.
 *
 * A previous version of this check required `snapshot.pb` and `ram.bin` to
 * have mtimes within 60 s of each other, on the theory that a save writes
 * both files in one batch. In practice the emulator updates `snapshot.pb`'s
 * metadata on *every load* (load count, last-loaded timestamp) even with
 * `-no-snapshot-save`, so the two mtimes drift apart by hours or days after
 * a few hot-boot sessions and the skew guard rejects every valid snapshot.
 * That manifested as "cold boot every single time" on macOS and Linux alike;
 * Linux just made it more painful because the cold boot is slower there.
 */
export async function hasDefaultBootSnapshot(avdName: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const avdPath = await resolveAvdPath(avdName);
  if (!avdPath) return false;
  const snapshotPath = `${avdPath}/snapshots/default_boot`;
  try {
    const [metaStat, ramStat] = await Promise.all([
      stat(`${snapshotPath}/snapshot.pb`),
      stat(`${snapshotPath}/ram.bin`),
    ]);
    if (!metaStat.isFile()) return false;
    if (!ramStat.isFile() || ramStat.size === 0) return false;
    return true;
  } catch {
    return false;
  }
}

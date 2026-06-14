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

// Memoize per (binary path + flag): `-help` output is stable for a given
// binary, and a boot may probe more than one flag. Cleared implicitly when the
// process restarts after an emulator update.
const emulatorFlagSupportCache = new Map<string, boolean>();

/**
 * Feature-detect whether the resolved `emulator` binary accepts a given
 * command-line flag, by checking whether it appears in `emulator -help`.
 *
 * Some launch flags exist only in newer emulator builds and are undocumented
 * in the release notes (e.g. `-crash-report-mode`, added in ~36.x and late
 * 35.x), so the binary's own `-help` listing is the only reliable signal.
 * Passing an unrecognized flag makes the emulator abort before boot, so callers
 * must gate on this before adding such a flag to the launch args.
 *
 * Best-effort: returns false if the binary cannot be resolved or `-help` cannot
 * be run, and never throws.
 */
export async function emulatorSupportsFlag(
  flag: string,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  let emulatorPath: string;
  try {
    emulatorPath = await resolveEmulatorOrThrow();
  } catch {
    return false;
  }

  const cacheKey = `${emulatorPath}|${flag}`;
  const cached = emulatorFlagSupportCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync(emulatorPath, ["-help"], {
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    output = stdout + stderr;
  } catch (err) {
    // `emulator -help` exits non-zero on some builds; the listing is still
    // attached to the error. Inspect whatever was captured before giving up.
    const e = err as { stdout?: string; stderr?: string };
    output = (e.stdout ?? "") + (e.stderr ?? "");
  }

  const supported = output.includes(flag);
  emulatorFlagSupportCache.set(cacheKey, supported);
  return supported;
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
    // Binary execs (runAdbBinary, encoding:"buffer") reject with Buffer
    // stderr/stdout, not string — coerce before trimming so this handler
    // never throws and mask the real adb diagnostic.
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const argv = args.join(" ");
  const asText = (v: string | Buffer | undefined): string =>
    v == null ? "" : v.toString();
  const ioDetail = asText(e.stderr).trim() || asText(e.stdout).trim();
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

/**
 * POSIX single-quote escape for a value interpolated into an `adb shell`
 * command string. `adb shell <str>` re-parses <str> through the device's
 * /bin/sh, so an unquoted bundleId/activity like `x; rm -rf /` would execute
 * on the device. Wrapping in single quotes and escaping embedded quotes makes
 * the value an inert single token. (open-url/platforms/android.ts already does
 * this inline for URLs; this is the shared form.)
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  /**
   * "tv" for an Android TV (leanback) device/emulator, "mobile" otherwise.
   * Mirrors `IosSimulator.runtimeKind` so a TV target is identified the same
   * way across platforms. Populated only for devices in the "device" state
   * (it needs a `getprop` round-trip); undefined when unknown.
   */
  runtimeKind?: "mobile" | "tv";
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
 * Detect whether an Android target is a TV (leanback) device. Android TV AVDs
 * and devices share the `emulator-NNNN` serial shape and `isEmulator` flag with
 * phones, so the serial alone can't tell them apart — only a device capability
 * can.
 *
 * The authoritative signal is the system feature list (`pm list features`):
 * `android.software.leanback` / `android.hardware.type.television` are exactly
 * what `PackageManager.hasSystemFeature(FEATURE_LEANBACK)` checks, and they are
 * present on every Android TV / Google TV image (physical and emulator). We do
 * NOT rely on `ro.build.characteristics` containing `tv`: it's correct on most
 * physical TV devices but the Google ATV *emulator* images report
 * `characteristics=emulator` (no `tv`), so a characteristics-only check
 * misclassifies every TV AVD as a phone. We keep the characteristics token as a
 * secondary fallback for the rare image where `pm list features` is unavailable.
 *
 * Best-effort: a failed/empty probe (mid-boot, locked-down device) resolves to
 * "mobile" rather than throwing, so discovery never fails on it.
 */
async function readRuntimeKind(serial: string): Promise<"mobile" | "tv"> {
  const features = await adbShell(serial, "pm list features", {
    timeoutMs: ENRICH_TIMEOUT_MS,
  }).catch(() => "");
  if (/feature:android\.(software\.leanback|hardware\.type\.television)\b/.test(features)) {
    return "tv";
  }

  // Fallback: the `tv` token in ro.build.characteristics. Correct on most
  // physical TV hardware; absent on the ATV emulator (hence the feature-list
  // primary above), but harmless to check when the feature list came back empty.
  const characteristics = await adbShell(serial, "getprop ro.build.characteristics", {
    timeoutMs: ENRICH_TIMEOUT_MS,
  }).catch(() => "");
  const isTv = characteristics
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .includes("tv");
  return isTv ? "tv" : "mobile";
}

// A device's form factor is fixed for the life of its boot (a phone image can't
// become a TV one), so memoize per-serial to keep the hot describe/navigate
// path off the `getprop` round-trip. Mirrors `runtimeKindCache` in ios-devices.
// Only "tv"/"mobile" verdicts are cached; the map is never populated for a
// device that isn't currently in the "device" state.
const androidRuntimeKindCache = new Map<string, "mobile" | "tv">();

/**
 * Resolve the runtime kind ("mobile" | "tv") of an Android serial, or undefined
 * when the device isn't currently listed in the "device" state (so a TV-only
 * tool can surface a clear error rather than driving an offline target).
 *
 * `resolveDevice` classifies by serial shape alone and tags every Android
 * target `platform: "android"`; code paths that must branch on Android TV
 * (the tv-* tools) call this for the real form factor. Parallels
 * `getSimulatorRuntimeKind` on the iOS side.
 */
export async function getAndroidRuntimeKind(
  serial: string
): Promise<"mobile" | "tv" | undefined> {
  const cached = androidRuntimeKindCache.get(serial);
  if (cached) return cached;
  const devices = await listAndroidDevices();
  const match = devices.find((d) => d.serial === serial && d.state === "device");
  if (!match?.runtimeKind) return undefined;
  androidRuntimeKindCache.set(serial, match.runtimeKind);
  return match.runtimeKind;
}

/** True when the given Android serial is an Android TV (leanback) target. */
export async function isAndroidTv(serial: string): Promise<boolean> {
  return (await getAndroidRuntimeKind(serial)) === "tv";
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
      const [model, sdk, avd, runtimeKind] = await Promise.all([
        adbShell(d.serial, "getprop ro.product.model", { timeoutMs: ENRICH_TIMEOUT_MS }).catch(
          () => ""
        ),
        adbShell(d.serial, "getprop ro.build.version.sdk", { timeoutMs: ENRICH_TIMEOUT_MS }).catch(
          () => ""
        ),
        readAvdName(d.serial),
        readRuntimeKind(d.serial),
      ]);
      const sdkLevel = parseInt(sdk.trim(), 10);
      return {
        serial: d.serial,
        state: d.state,
        isEmulator: d.serial.startsWith("emulator-"),
        model: model.trim() || null,
        avdName: avd,
        sdkLevel: Number.isFinite(sdkLevel) ? sdkLevel : null,
        runtimeKind,
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
            ` Authorise the device, reconnect it, or pick a different target.`,
          { cause: err }
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
 * `loadable === true` is necessary but not sufficient — the probe validates
 * metadata + renderer but not `ram.bin` integrity (a partial save still says
 * "Loadable" then crashes QEMU with `std::bad_alloc`). Pair with
 * `-force-snapshot-load` in the boot spawn so ram.bin corruption fails loudly.
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
    // Renderer-affecting flags (`-gpu auto` etc.) MUST match the boot spawn's
    // argv, or the probe resolves a different renderer and rejects valid
    // snapshots with "different renderer configured". See
    // boot-device.ts:RENDERER_ARGS — caller threads the same flags through.
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
    // "WARNING | change of renderer detected" is noise, not a failure signal.
    // Actual incompatibility surfaces as a `Reason:` line with no `Loadable`
    // (e.g. gfxstream mismatch). Trust the final `Loadable` line — it's the
    // emulator's authoritative verdict.
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
 * Candidate AVD-root directories, in the priority order the emulator binary
 * itself uses (`external/qemu/.../avd/util.cpp`). Mirroring its order is what
 * lets argent find AVDs on Linux Studio setups that default to `ANDROID_USER_HOME`
 * or `XDG_CONFIG_HOME` instead of `$HOME`.
 *
 *   1. `$ANDROID_USER_HOME/avd`         — current Studio convention (≥ 4.2)
 *   2. `$ANDROID_AVD_HOME`              — explicit override (files live here)
 *   3. `$XDG_CONFIG_HOME/Android/avd`   — Linux XDG
 *   4. `$ANDROID_SDK_HOME/.android/avd` — legacy
 *   5. `$HOME/.android/avd`             — default
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
 * Resolve an AVD's `.avd` folder by reading `path=` from `<root>/<name>.ini`.
 * The `.avd` can live outside the convention root (Studio relocations,
 * snap-installed Studio puts them under `~/snap/...`), so the `.ini` is
 * the authoritative source. Returns null if no `<name>.ini` is found.
 */
export async function resolveAvdPath(avdName: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  for (const root of avdRootCandidates()) {
    try {
      const ini = await readFile(`${root}/${avdName}.ini`, "utf-8");
      const match = ini.match(/^path\s*=\s*(.+?)\s*$/m);
      if (!match || !match[1]) continue;
      // `(.+?)` must match ≥1 char, so `path=   ` captures a single space —
      // trim it, then reject anything non-absolute (the emulator always
      // writes an absolute path; relative would resolve against cwd).
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
 * Cheap pre-filter — `-snapshot-list` would spawn the emulator, the very
 * hang we're trying to avoid.
 *
 * Intentionally lenient: just `snapshot.pb` exists and `ram.bin` is non-empty.
 * `-check-snapshot-loadable` validates metadata + renderer next, and
 * `-force-snapshot-load` in the boot spawn surfaces ram.bin corruption as a
 * loud early-exit. Don't gate on mtime-skew: the emulator touches `snapshot.pb`
 * on every load (even with `-no-snapshot-save`), so a few hot-boots drift it
 * days ahead of `ram.bin` and the skew check rejects every valid snapshot.
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

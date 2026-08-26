import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `sim-remote` CLI.
 *
 * Failures throw with the CLI's stderr appended, so auth and orchestrator-side
 * errors reach the agent verbatim. Commands taking a device id strip a
 * `remote:` prefix, so callers need not normalise first.
 */

import { stripRemotePrefix } from "./device-info";
import { isIosOrTvOsRuntimeId, runtimeKindFromRuntimeId } from "./ios-devices";

const DEFAULT_TIMEOUT_MS = 30_000;

interface SimRemoteOptions {
  timeoutMs?: number;
  stdin?: string;
}

async function run(args: string[], options?: SimRemoteOptions): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFileAsync("sim-remote", args, {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      input: options?.stdin,
    } as Parameters<typeof execFileAsync>[2]);
    return { stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8") };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = (e.stderr ?? "").trim();
    const stdout = (e.stdout ?? "").trim();
    const suffix = stderr || stdout || e.message;
    throw new Error(`sim-remote ${args.join(" ")} failed: ${suffix}`, { cause: err });
  }
}

/**
 * Shape of `sim-remote simctl list devices --json`, mirroring Apple's
 * `xcrun simctl list devices --json`.
 */
interface SimRemoteDevice {
  udid: string;
  name: string;
  state: string; // "Booted" | "Shutdown" | ...
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

interface SimRemoteListDevicesResult {
  devices: Record<string, SimRemoteDevice[]>;
}

export async function simctlListDevices(): Promise<SimRemoteListDevicesResult> {
  const { stdout } = await run(["simctl", "list", "devices", "--json"]);
  try {
    return JSON.parse(stdout) as SimRemoteListDevicesResult;
  } catch (err) {
    throw new Error(
      `sim-remote simctl list devices --json returned non-JSON output: ${(err as Error).message}`,
      { cause: err }
    );
  }
}

/**
 * The listing's runtime-id -> simulators entries, or undefined when the payload
 * parsed but isn't a listing (e.g. `{"error":...}` at exit 0). A runtime entry
 * whose value is not an array is dropped, so one malformed entry costs its own
 * simulators rather than every entry behind it.
 *
 * Callers share the shape check but not the verdict on undefined:
 * `getRemoteSimulatorRuntimeKind` throws, `list-devices` reports the platform
 * absent.
 */
export function listedRuntimeEntries(
  listed: SimRemoteListDevicesResult
): Array<[string, SimRemoteDevice[]]> | undefined {
  const byRuntime = (listed as { devices?: unknown } | null)?.devices;
  if (typeof byRuntime !== "object" || byRuntime === null) return undefined;
  return Object.entries(byRuntime).filter((entry): entry is [string, SimRemoteDevice[]] =>
    Array.isArray(entry[1])
  );
}

/**
 * A runtime entry's usable simulators. A row that is not an object carrying a
 * string `udid` is dropped, so one malformed row costs its own simulator rather
 * than every row behind it.
 */
export function listedRuntimeDevices(devices: SimRemoteDevice[]): SimRemoteDevice[] {
  return (devices as unknown[]).filter(
    (d): d is SimRemoteDevice =>
      typeof d === "object" && d !== null && typeof (d as { udid?: unknown }).udid === "string"
  );
}

// A simulator's runtime kind is fixed at creation, so memoize it per bare udid
// and keep the `sim-remote simctl list` round-trip off repeated calls — the
// same deal (and the same shape) as the local `getSimulatorRuntimeKind`, down
// to caching verdicts only: an unknown udid re-probes, since the sim may not
// have been created yet when the first call landed, and probes racing the same
// udid before either lands each pay their own round-trip.
const remoteRuntimeKindCache = new Map<string, "mobile" | "tv">();

/**
 * Resolve the runtime kind ("mobile" | "tv") of a remote simulator, or undefined
 * when the listing answered but doesn't know the udid. A `sim-remote` failure
 * (missing binary, expired auth, orchestrator down) propagates instead — per the
 * module's contract, so the CLI's stderr reaches the agent verbatim.
 *
 * The remote analogue of `getSimulatorRuntimeKind`: `classifyDevice` tags every
 * `remote:`-prefixed id `ios-remote` by shape alone, so a caller that must tell
 * tvOS from iOS reads the real runtime off the listing's runtime-id key here.
 */
export async function getRemoteSimulatorRuntimeKind(
  udid: string
): Promise<"mobile" | "tv" | undefined> {
  const bare = stripRemotePrefix(udid);
  const cached = remoteRuntimeKindCache.get(bare);
  if (cached) return cached;
  const listed = await simctlListDevices();
  // A payload that parses but isn't a listing (e.g. `{"error":...}` at exit 0)
  // gets the same descriptive wrap as non-JSON output, not a raw TypeError.
  const entries = listedRuntimeEntries(listed);
  if (!entries) {
    throw new Error("sim-remote simctl list devices --json returned JSON without a devices map");
  }
  for (const [runtimeId, devices] of entries) {
    // Mirror the local classifier's runtime filter, so a watchOS / xrOS sim comes
    // back unverifiable instead of falling into the `mobile` default below.
    if (!isIosOrTvOsRuntimeId(runtimeId)) continue;
    // Mirror `listRemoteIosSimulators`' availability filter, so a simulator
    // `list-devices` hides can't be the one that answers here.
    if (!listedRuntimeDevices(devices).some((d) => d.udid === bare && d.isAvailable !== false))
      continue;
    const kind = runtimeKindFromRuntimeId(runtimeId);
    remoteRuntimeKindCache.set(bare, kind);
    return kind;
  }
  return undefined;
}

/**
 * True when a remote UDID is a tvOS (Apple TV) simulator.
 *
 * The remote analogue of `isTvOsSimulator`. Callers use it to *narrow* an
 * already-supported device, so an unanswerable lookup reads as non-TV rather
 * than throwing: a listing the orchestrator can't serve must not turn a working
 * phone simulator into an error.
 */
export async function isRemoteTvOsSimulator(udid: string): Promise<boolean> {
  try {
    return (await getRemoteSimulatorRuntimeKind(udid)) === "tv";
  } catch {
    return false;
  }
}

/** Test-only: clear the remote runtime-kind memo so cases don't leak verdicts. */
export function __resetRemoteSimulatorRuntimeKindCacheForTesting(): void {
  remoteRuntimeKindCache.clear();
}

export async function simctlBoot(udid: string): Promise<void> {
  await run(["simctl", "boot", stripRemotePrefix(udid)]);
}

export async function simctlShutdown(udid: string): Promise<void> {
  await run(["simctl", "shutdown", stripRemotePrefix(udid)]);
}

export async function simctlBootstatus(udid: string, opts?: { boot?: boolean }): Promise<void> {
  const args = ["simctl", "bootstatus"];
  if (opts?.boot) args.push("-b");
  args.push(stripRemotePrefix(udid));
  // Cold boot can take minutes.
  await run(args, { timeoutMs: 5 * 60_000 });
}

export async function simctlLaunch(
  udid: string,
  bundleId: string,
  args: string[] = []
): Promise<void> {
  await run(["simctl", "launch", stripRemotePrefix(udid), bundleId, ...args]);
}

export async function simctlTerminate(udid: string, bundleId: string): Promise<void> {
  await run(["simctl", "terminate", stripRemotePrefix(udid), bundleId]);
}

export async function simctlInstall(udid: string, localAppPath: string): Promise<void> {
  // Uploading a large .app to the orchestrator can take minutes.
  await run(["simctl", "install", stripRemotePrefix(udid), localAppPath], {
    timeoutMs: 5 * 60_000,
  });
}

export async function simctlUninstall(udid: string, bundleId: string): Promise<void> {
  await run(["simctl", "uninstall", stripRemotePrefix(udid), bundleId]);
}

export async function simctlOpenUrl(udid: string, url: string): Promise<void> {
  await run(["simctl", "openurl", stripRemotePrefix(udid), url]);
}

/**
 * Remote analogue of `xcrun simctl privacy <udid> <action> <service> <bundleId>`
 * — edits the remote simulator's TCC store.
 */
export async function simctlPrivacy(
  udid: string,
  action: string,
  service: string,
  bundleId: string
): Promise<void> {
  await run(["simctl", "privacy", stripRemotePrefix(udid), action, service, bundleId]);
}

/** Copy text into the simulator's pasteboard (streamed over stdin). */
export async function simctlPbcopy(udid: string, text: string): Promise<void> {
  await run(["simctl", "pbcopy", stripRemotePrefix(udid)], { stdin: text });
}

interface SpawnResult {
  /** Set when spawned detached. */
  pid?: number;
  /** Set when run to completion (non-detached). */
  exitCode?: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `simctl spawn` on the remote simulator. With `binPath`, the binary is
 * uploaded and run as argv[0] with `args` appended; otherwise `args` is the
 * full in-simulator argv (e.g. `["launchctl", "list"]`). `detach` leaves the
 * process running and returns its pid.
 */
export async function simctlSpawn(
  udid: string,
  opts: { binPath?: string; args?: string[]; detach?: boolean }
): Promise<SpawnResult> {
  const cmd = ["spawn", stripRemotePrefix(udid)];
  if (opts.binPath) cmd.push("--bin", opts.binPath);
  if (opts.detach) cmd.push("--detach");
  // Without `--json` a non-detached spawn streams the child's raw output live
  // instead of the one-shot `{exit_code,stdout,stderr}` object parsed below.
  cmd.push("--json");
  const args = opts.args ?? [];
  if (args.length > 0) cmd.push("--", ...args);
  // Allow for a binary upload.
  const { stdout } = await run(cmd, { timeoutMs: 60_000 });
  try {
    const parsed = JSON.parse(stdout) as {
      pid?: number | null;
      exit_code?: number | null;
      stdout?: string | null;
      stderr?: string | null;
    };
    return {
      pid: parsed.pid ?? undefined,
      exitCode: parsed.exit_code ?? undefined,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
    };
  } catch (err) {
    throw new Error(`sim-remote spawn returned non-JSON output: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Upload a dylib to the remote simulator. With `insert`, it is added to
 * `DYLD_INSERT_LIBRARIES`; otherwise it is only staged, co-located so a
 * primary dylib can `@loader_path`-resolve it.
 */
export async function injectDylib(
  udid: string,
  opts: { filePath: string; insert?: boolean }
): Promise<void> {
  const args = ["dylib", "add", stripRemotePrefix(udid), opts.filePath];
  if (opts.insert) args.push("--insert");
  await run(args, { timeoutMs: 60_000 });
}

/** Set a launchd environment variable inside the remote simulator. */
export async function setSimulatorEnv(udid: string, key: string, value: string): Promise<void> {
  await run(["setenv", stripRemotePrefix(udid), key, value]);
}

/**
 * Start a TCP tunnel on `<port>` between the host and the remote simulator.
 *
 * Idempotent: re-running with the same (udid, port) tolerates "already
 * started" errors so blueprints don't have to track tunnel ownership across
 * service restarts.
 */
export async function proxyStart(udid: string, port: number): Promise<void> {
  try {
    await run(["proxy", "start", stripRemotePrefix(udid), String(port)]);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/already/i.test(message)) return;
    throw err;
  }
}

export async function proxyStop(udid: string, port: number): Promise<void> {
  try {
    await run(["proxy", "stop", stripRemotePrefix(udid), String(port)]);
  } catch {
    // best-effort cleanup
  }
}

export interface MoqInfo {
  url: string;
  fingerprint: string;
  token: string;
}

export async function moqInfo(udid: string): Promise<MoqInfo> {
  const { stdout } = await run(["moq-info", stripRemotePrefix(udid)]);
  try {
    return JSON.parse(stdout) as MoqInfo;
  } catch (err) {
    throw new Error(`sim-remote moq-info returned non-JSON output: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

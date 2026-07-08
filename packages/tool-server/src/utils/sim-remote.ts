import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `sim-remote` CLI.
 *
 * All commands shell out to `sim-remote` and propagate exit-code failures as
 * thrown errors with the CLI's stderr appended to the message — so auth and
 * orchestrator-side errors reach the agent verbatim instead of being smoothed
 * over here.
 *
 * Each function strips the `remote:` prefix off device ids if present, so
 * callers don't have to remember whether the id they're holding has been
 * normalised yet.
 */

import { stripRemotePrefix } from "./device-info";

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
      // sim-remote pipes stdin through to pbcopy etc.
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

// ── simctl ──

/**
 * Shape of `sim-remote simctl list devices --json`. Mirrors Apple's
 * `xcrun simctl list devices --json` output: `{ devices: { <runtime>: [ ... ] } }`.
 */
export interface SimRemoteDevice {
  udid: string;
  name: string;
  state: string; // "Booted" | "Shutdown" | ...
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

export interface SimRemoteListDevicesResult {
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
  // Bootstatus may take a long while on cold boot; give it 5 min.
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
  // sim-remote uploads the local .app to the orchestrator over QUIC.
  // Large bundles can take a while; give 5 min.
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

/** Copy the given text into the simulator's pasteboard (sim-remote streams stdin). */
export async function simctlPbcopy(udid: string, text: string): Promise<void> {
  await run(["simctl", "pbcopy", stripRemotePrefix(udid)], { stdin: text });
}

export async function simctlPbpaste(udid: string): Promise<string> {
  const { stdout } = await run(["simctl", "pbpaste", stripRemotePrefix(udid)]);
  return stdout;
}

// ── generic in-simulator primitives ──

export interface SpawnResult {
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
 * process running and returns its pid instead of waiting.
 */
export async function simctlSpawn(
  udid: string,
  opts: { binPath?: string; args?: string[]; detach?: boolean }
): Promise<SpawnResult> {
  const cmd = ["spawn", stripRemotePrefix(udid)];
  if (opts.binPath) cmd.push("--bin", opts.binPath);
  if (opts.detach) cmd.push("--detach");
  const args = opts.args ?? [];
  if (args.length > 0) cmd.push("--", ...args);
  // Uploading a binary can take a moment; allow more than the default.
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
 * `DYLD_INSERT_LIBRARIES`; otherwise it is only staged (co-located so a primary
 * dylib can `@loader_path`-resolve it).
 */
export async function injectDylib(
  udid: string,
  opts: { filePath: string; insert?: boolean }
): Promise<void> {
  const args = ["dylib", "add", stripRemotePrefix(udid), opts.filePath];
  if (opts.insert) args.push("--insert");
  await run(args, { timeoutMs: 60_000 });
}

export async function removeDylib(udid: string, filename: string): Promise<void> {
  await run(["dylib", "remove", stripRemotePrefix(udid), filename]);
}

/** Set a launchd environment variable inside the remote simulator. */
export async function setSimulatorEnv(udid: string, key: string, value: string): Promise<void> {
  await run(["setenv", stripRemotePrefix(udid), key, value]);
}

// ── proxy ──

/**
 * Start a TCP tunnel: incoming connections on the host's `localhost:<port>`
 * are forwarded by the daemon to the same port inside the remote simulator.
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

// ── moq ──

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

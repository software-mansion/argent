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
    throw new Error(`sim-remote ${args.join(" ")} failed: ${suffix}`);
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
      `sim-remote simctl list devices --json returned non-JSON output: ${(err as Error).message}`
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

// ── setup ──

export async function setupAccessibilityDefaults(udid: string): Promise<void> {
  await run(["setup", "accessibility-defaults", stripRemotePrefix(udid)]);
}

export async function setupNativeDevtools(
  udid: string,
  opts: { libs: string[]; cdpPort: number }
): Promise<void> {
  const args = ["setup", "native-devtools"];
  for (const lib of opts.libs) args.push("--lib", lib);
  args.push("--cdp-port", String(opts.cdpPort), stripRemotePrefix(udid));
  await run(args);
}

/**
 * Returns the bundle ids of UIKitApplications currently running on the
 * remote simulator (orchestrator-side `setup running-bundle-ids`).
 */
export async function setupRunningBundleIds(udid: string): Promise<string[]> {
  const { stdout } = await run(["setup", "running-bundle-ids", stripRemotePrefix(udid)]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function setupAxService(
  udid: string,
  opts: { port: number; timeoutSecs?: number }
): Promise<void> {
  await run([
    "setup",
    "ax-service",
    "--port",
    String(opts.port),
    "--timeout-secs",
    String(opts.timeoutSecs ?? 3600),
    stripRemotePrefix(udid),
  ]);
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
}

export async function moqInfo(udid: string): Promise<MoqInfo> {
  const { stdout } = await run(["moq-info", stripRemotePrefix(udid)]);
  try {
    return JSON.parse(stdout) as MoqInfo;
  } catch (err) {
    throw new Error(`sim-remote moq-info returned non-JSON output: ${(err as Error).message}`);
  }
}

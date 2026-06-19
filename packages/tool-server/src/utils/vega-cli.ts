import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Resolve the Vega CLI binary (`vega`, or its `kepler` alias). Mirrors how
 * `android-binary.ts` resolves `adb`: prefer whatever is on PATH, then fall
 * back to the SDK's default install location so a host that ran the Vega
 * installer but never sourced `~/vega/env` still works.
 *
 *   1. `vega` on PATH            — the common case after `source ~/vega/env`
 *   2. `kepler` on PATH          — legacy alias (symlink to the same binary)
 *   3. `~/vega/bin/vega`         — SDK default install location
 *
 * Result is memoized for the process: the binary location does not move within
 * a session, and `command -v` per hot tool call would dominate latency.
 */
let cachedVegaBinary: string | null | undefined;

async function commandOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
      timeout: 2_000,
    });
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

export async function resolveVegaBinary(): Promise<string | null> {
  if (cachedVegaBinary !== undefined) return cachedVegaBinary;
  const onPath = (await commandOnPath("vega")) ?? (await commandOnPath("kepler"));
  if (onPath) {
    cachedVegaBinary = onPath;
    return onPath;
  }
  const fallback = join(homedir(), "vega", "bin", "vega");
  cachedVegaBinary = existsSync(fallback) ? fallback : null;
  return cachedVegaBinary;
}

/** Test-only: clear the binary-resolution memo. */
export function __resetVegaBinaryCacheForTests(): void {
  cachedVegaBinary = undefined;
}

async function resolveVegaOrThrow(): Promise<string> {
  const path = await resolveVegaBinary();
  if (!path) {
    throw new Error(
      "`vega` (or `kepler`) not found on PATH or under `~/vega/bin`. " +
        "Install the Vega SDK and run `source ~/vega/env`, then retry."
    );
  }
  return path;
}

export interface VegaRunResult {
  stdout: string;
  stderr: string;
}

// As with adb, a hung `vega` child can ignore SIGTERM (it shells out to the
// device agent), so force the kill at the timeout boundary.
const VEGA_KILL_SIGNAL = "SIGKILL" as const;

/**
 * Resolve a guaranteed-live working directory for the spawned `vega`/`kepler`
 * child. The tool-server is a long-lived singleton; if it was started from a
 * directory that is later removed (e.g. a git worktree torn down mid-session),
 * `process.cwd()` itself throws ENOENT and any child inherits that dead cwd —
 * the `vega` Python CLI then crashes in `config.py find_workspace -> os.getcwd()`
 * with "getcwd: cannot access parent directories". adb-channel tools are immune
 * (adb never calls getcwd), which is why only the CLI-backed Vega tools hit this.
 *
 * Validate the server's cwd and fall back to the OS temp dir (always present) so
 * device-level `vega` commands — which don't need the project workspace — keep
 * working without a full tool-server restart. Dependencies are injected so a unit
 * test can simulate a missing cwd.
 */
export function resolveSpawnCwd(
  getCwd: () => string = () => process.cwd(),
  dirExists: (p: string) => boolean = existsSync,
  fallback: string = tmpdir()
): string {
  try {
    const cwd = getCwd();
    if (dirExists(cwd)) return cwd;
  } catch {
    // process.cwd() throws when the directory was removed under the server.
  }
  return fallback;
}

function describeVegaFailure(args: string[], err: unknown): Error {
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
  if (ioDetail) return new Error(`vega ${argv} failed: ${ioDetail}`);
  const meta: string[] = [];
  if (e.killed) meta.push("killed=true");
  if (e.signal) meta.push(`signal=${e.signal}`);
  if (e.code) meta.push(`code=${e.code}`);
  const baseMsg = (e.message ?? String(err)).trim();
  const suffix = meta.length ? ` (${meta.join(" ")})` : "";
  return new Error(`vega ${argv} failed: ${baseMsg}${suffix}`);
}

/**
 * Run the `vega`/`kepler` CLI directly. Callers that target a specific device
 * must pass `-d <serial>` (or `--device <serial>`) themselves via `args` — like
 * `runAdb`, this does not inject a serial; a serial-less call hits the single
 * connected device or fails if there are several.
 */
export async function runVega(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  const vegaPath = await resolveVegaOrThrow();
  try {
    const { stdout, stderr } = await execFileAsync(vegaPath, args, {
      // Pin to a guaranteed-live cwd so a since-deleted server cwd doesn't crash
      // the `vega` CLI in os.getcwd() (see resolveSpawnCwd).
      cwd: resolveSpawnCwd(),
      timeout: options.timeoutMs ?? 60_000,
      killSignal: VEGA_KILL_SIGNAL,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
    });
    return { stdout, stderr };
  } catch (err) {
    throw describeVegaFailure(args, err);
  }
}

/**
 * Run `vega device <subcommand…>` against a device.
 *
 * NOTE (v1, Virtual-Device-only): the CLI's `-d/--device <serial>` flag does
 * NOT match the running Virtual Device by the serial that `device list`/`info`
 * report — passing it yields an empty `unknown` device, while omitting it
 * correctly targets the single connected device (the CLI documents `-d` as
 * "Defaults to the connected device if there is only one"). So we rely on that
 * default and do not inject `-d`; with more than one device connected the CLI
 * itself errors rather than guessing. `serial` is validated non-empty to catch
 * a caller that forgot to thread the udid, but is not otherwise used.
 */
export async function vegaDevice(
  serial: string,
  subcommand: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  if (!serial) throw new Error("vegaDevice requires a non-empty device serial");
  return runVega(["device", ...subcommand], options);
}

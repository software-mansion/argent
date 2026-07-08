import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { homedir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, unlink, rename, chmod } from "node:fs/promises";

const STATE_DIR = path.join(homedir(), ".argent");
// Legacy single-slot state file. Read (and cleared when it records the
// caller's own bundle) for older-argent compat, but never written — each
// install now has its own per-bundle file (see stateFileForBundle).
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");
// Cross-process mutex guarding the "decide whether to spawn, then spawn" critical
// section of ensureToolsServer (see acquireSpawnLock). Lives next to the state
// file so it shares the state dir's lifecycle.
const LOCK_FILE = path.join(STATE_DIR, "tool-server.lock");

const AUTH_TOKEN_BYTES = 32;
export const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";

// Idle-shutdown policy for auto-spawned servers (MCP / `argent run` path). The
// CLI's `argent server start` overrides this; manual launches default to no
// timeout.
const AUTOSPAWN_IDLE_TIMEOUT_MINUTES = 30;

/**
 * Filesystem locations the launcher needs to spawn tool-server. Provided by
 * the consuming package (typically the published `@swmansion/argent`), since
 * only that layer knows where its bundled artifacts live.
 */
export interface ToolsServerPaths {
  /** Path to the bundled tool-server.cjs */
  bundlePath: string;
  /** Directory containing the simulator-server binary */
  simulatorServerDir: string;
  /** Directory containing the native devtools dylibs */
  nativeDevtoolsDir: string;
  /**
   * Installed package version AT MODULE IMPORT. Optional. The version gate
   * reads the bundle's package.json fresh on every call (see reusableHandle);
   * this frozen value is only the fallback when that disk read fails.
   */
  version?: string;
  /**
   * Install topology: project-local devDependency or global PATH install.
   * Optional. Classified by the consuming package AT SPAWN TIME — while its
   * cwd is still meaningful — and exported as ARGENT_INSTALL_KIND, so tools
   * like update-argent don't re-infer it from a cwd an editor may have set to
   * `/` or `$HOME`.
   */
  installKind?: "global" | "local";
  /**
   * For a local install, the project root whose node_modules holds the
   * package. Classified alongside `installKind` and exported as
   * ARGENT_PROJECT_ROOT, so `argent update --local` can pin the updater's cwd
   * to the right project instead of the tool-server's editor-chosen cwd.
   */
  installProjectRoot?: string;
}

export interface BuildToolsServerEnvOptions {
  /** Bind host. Omit to inherit the tool-server default (127.0.0.1). */
  host?: string;
  /** Idle-timeout minutes (0 disables). Omit to inherit the tool-server default. */
  idleTimeoutMinutes?: number;
  /**
   * Per-process auth token. When set, exported as `ARGENT_AUTH_TOKEN` so the
   * tool-server enforces `Authorization: Bearer <token>`. Omit (or pass empty)
   * to run the server with authentication disabled — used by the manual
   * `argent server start` path, which prints its own no-auth warning.
   */
  token?: string;
}

export function buildToolsServerEnv(
  paths: ToolsServerPaths,
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: BuildToolsServerEnvOptions = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ARGENT_PORT: String(port),
    ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
    ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
  };
  if (options.host !== undefined) env.ARGENT_HOST = options.host;
  if (options.idleTimeoutMinutes !== undefined) {
    env.ARGENT_IDLE_TIMEOUT_MINUTES = String(options.idleTimeoutMinutes);
  }
  if (options.token) env[AUTH_TOKEN_ENV] = options.token;
  if (paths.installKind) env.ARGENT_INSTALL_KIND = paths.installKind;
  if (paths.installProjectRoot) env.ARGENT_PROJECT_ROOT = paths.installProjectRoot;
  return env;
}

export interface ToolsServerState {
  port: number;
  pid: number;
  startedAt: string;
  bundlePath: string;
  /**
   * Version of the package that spawned this server. Optional for backward-compat
   * with state files written by older versions (treated as "unknown" — reused
   * rather than forcing a respawn). See reusableHandle.
   */
  version?: string;
  /** Bind host. Optional for backward-compat with state files written by older versions. */
  host?: string;
  /**
   * Per-process random token. When present, required as
   * `Authorization: Bearer <token>` on every tool-server request. Persisted
   * with mode 0600 so other users on the host can't read it. Optional:
   * `argent server start` writes tokenless (auth-disabled) state.
   */
  token?: string;
  /**
   * Who owns this server's lifecycle. `autospawn` — spawned on demand by the
   * MCP / `argent run` path (ensureToolsServer), safe for that path to replace.
   * `cli` — a long-lived server the user started explicitly with
   * `argent server start` (possibly under a process supervisor); the auto-spawn
   * path must NOT terminate it. Absent on legacy state files, which are treated
   * conservatively as "not ours to kill".
   */
  managed?: "autospawn" | "cli";
}

/** Handle returned to clients: the base URL plus the matching auth token. */
export interface ToolsServerHandle {
  url: string;
  token: string;
}

function generateToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString("hex");
}

/**
 * Mint a fresh tool-server auth token. Exposed so `argent server start` can
 * issue one for a long-lived / remote server.
 */
export function generateAuthToken(): string {
  return generateToken();
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") {
        srv.close(() => reject(new Error("Could not bind to find free port")));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

/**
 * True iff semver `a` is strictly newer than `b`, INCLUDING prerelease
 * precedence — truncating the tag would compare 0.14.0-rc.1 and 0.14.0-rc.2
 * equal and keep reusing a stale server. Anything unparseable compares as
 * "not newer" so the caller reuses rather than kills.
 */
export function isVersionNewer(a: string, b: string): boolean {
  const parse = (v: string): { nums: number[]; pre: string[] } | null => {
    // Strip build metadata; split "1.2.3-rc.2" into numeric core + prerelease ids.
    const [core = "", ...preParts] = v.split("+")[0]!.split("-");
    const nums = core.split(".").map((n) => Number.parseInt(n, 10));
    if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return null;
    return { nums, pre: preParts.length > 0 ? preParts.join("-").split(".") : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  // Equal numeric core: per semver, a release outranks its prereleases, and
  // prerelease identifiers compare field-by-field (numeric < alphanumeric,
  // numerics numerically, alphanumerics lexically; more fields wins a prefix).
  if (pa.pre.length === 0 && pb.pre.length === 0) return false;
  if (pa.pre.length === 0) return true;
  if (pb.pre.length === 0) return false;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return false; // a is a prefix of b → a is older
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number.parseInt(x, 10) : null;
    const yn = /^\d+$/.test(y) ? Number.parseInt(y, 10) : null;
    if (xn !== null && yn !== null) return xn > yn;
    if (xn !== null) return false; // numeric < alphanumeric
    if (yn !== null) return true;
    return x > y;
  }
  return false;
}

/**
 * The CURRENT on-disk version of the bundle's install, read fresh from the
 * package.json one level above its dist/ dir. Never cached: `paths.version`
 * is frozen at module import, which would leave a long-lived MCP process
 * blind to in-place bumps or downgrades.
 */
function readBundlePackageVersion(bundlePath: string): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(bundlePath), "..", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isToolsServerProcessAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

/**
 * The wildcard hosts (`0.0.0.0`, `::`) accept connections on every interface
 * including loopback, but you cannot _connect_ to them — for the health check
 * we have to use a routable address.
 */
function healthCheckHost(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

function formatUrl(host: string, port: number): string {
  // Bracket IPv6 literals in URLs.
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function isToolsServerHealthy(
  port: number,
  host: string = "127.0.0.1",
  timeoutMs = 2000,
  token?: string
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${formatUrl(healthCheckHost(host), port)}/tools`, {
      signal: controller.signal,
      headers: authHeaders(token),
    });
    // Release the response body before returning. /tools is a large (~100KB+)
    // payload and we only need the status; an unread body keeps undici's
    // keep-alive socket *ref'd* until the server's idle keepAliveTimeout (~5s)
    // closes it, which makes every natural-exit CLI command (`argent run …`,
    // `argent tools`) hang ~6s after it has already printed its result. Cancelling
    // frees the socket immediately so the event loop can drain and the process exit.
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface SpawnToolsServerOptions extends BuildToolsServerEnvOptions {
  /**
   * Readiness timeout in ms (how long to wait for the "listening" banner before
   * giving up). Defaults to {@link SPAWN_READY_TIMEOUT_MS}. Exposed for tests so
   * the kill-on-timeout path can be exercised without a 15s wait.
   */
  readyTimeoutMs?: number;
}

const SPAWN_READY_TIMEOUT_MS = 15_000;

/**
 * SIGKILL the spawned child's whole process group. The child is started
 * `detached`, so it is its own group leader (setsid) and `kill(-pid)` reaps it
 * plus anything it spawned. Best-effort: by the time this runs the child may
 * already be gone.
 */
function killSpawnedChild(child: ReturnType<typeof spawn>, pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function spawnToolsServer(
  paths: ToolsServerPaths,
  port: number,
  options: SpawnToolsServerOptions = {}
): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    let logFd: number;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      logFd = fs.openSync(LOG_FILE, "a");
    } catch {
      logFd = fs.openSync("/dev/null", "w");
    }

    const child = spawn("node", [paths.bundlePath, "start"], {
      detached: true,
      stdio: ["ignore", "pipe", logFd],
      env: buildToolsServerEnv(paths, port, process.env, options),
    });

    child.unref();

    const pid = child.pid;
    if (!pid) {
      reject(new Error("Failed to get PID of spawned tools server"));
      return;
    }

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Reject AND reap: the child is detached + unref'd, so a bare reject would
    // leave it to bind its port seconds later as an untracked orphan (the very
    // "two servers alive" failure this module guards against). Kill it first.
    const rejectAndKill = (err: Error) =>
      settle(() => {
        killSpawnedChild(child, pid);
        reject(err);
      });

    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      // Match: "Tools server listening on http://<host>:<port>"
      // Greedy `.+` then `:digits` backtracks to the trailing port, so this
      // works for hostnames, IPv4 (`127.0.0.1`), and bracketed IPv6 (`[::1]`).
      const match = line.match(/Tools server listening on http:\/\/.+:(\d+)/);
      if (match) {
        const actualPort = parseInt(match[1]!, 10);
        rl.close();
        // Resume stdout so the pipe keeps draining and the child's console.log
        // calls don't back up once the readline interface stops consuming it.
        child.stdout?.resume();
        // ...but unref the pipe socket so it does NOT keep OUR event loop alive.
        // `child.unref()` only detaches the process handle; the stdout pipe is a
        // separate ref'd handle. Without this, a short-lived caller like
        // `argent run <tool>` would print its result and then hang forever
        // waiting on the drained-but-open pipe. A long-lived caller (the MCP
        // launcher) keeps its loop alive by other means, so it still drains
        // normally; and the tool-server tolerates the eventual EPIPE when we exit.
        // (stdio "pipe" makes this a net.Socket at runtime, which has unref();
        // the ChildProcess type widens it to Readable, so narrow before calling.)
        (child.stdout as { unref?: () => void } | null)?.unref?.();
        settle(() => resolve({ port: actualPort, pid }));
      }
    });

    child.on("error", (err) => {
      rl.close();
      // A spawn-level error (ENOENT/EACCES) usually means no child exists; the
      // kill is a harmless no-op in that case but reaps a half-started one.
      rejectAndKill(err);
    });

    child.on("exit", (code) => {
      rl.close();
      // Child already exited — nothing to reap, just surface it.
      settle(() => reject(new Error(`tool-server exited with code ${code} before becoming ready`)));
    });

    const timer = setTimeout(() => {
      rl.close();
      rejectAndKill(new Error("Timed out waiting for tools server to become ready"));
    }, options.readyTimeoutMs ?? SPAWN_READY_TIMEOUT_MS);

    rl.on("close", () => clearTimeout(timer));
  });
}

/**
 * Per-bundle state file for a tool-server bundle. Each argent install has a
 * distinct bundlePath and therefore its own slot, so one install spawning its
 * server never clobbers another's record and orphans that server (the
 * single-slot failure mode).
 */
export function stateFileForBundle(bundlePath: string): string {
  const key = createHash("sha256").update(bundlePath).digest("hex").slice(0, 12);
  return path.join(STATE_DIR, `tool-server-${key}.json`);
}

async function readStateFile(file: string): Promise<ToolsServerState | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ToolsServerState;
  } catch {
    return null;
  }
}

/**
 * Read the tracked tool-server state. With `bundlePath`, resolve THAT
 * install's record: per-bundle file first, then the legacy single-slot file
 * when it records the same bundle. Without, read the legacy file only
 * (backward-compat shape).
 */
export async function readToolsServerState(bundlePath?: string): Promise<ToolsServerState | null> {
  if (bundlePath === undefined) return readStateFile(STATE_FILE);
  const own = await readStateFile(stateFileForBundle(bundlePath));
  if (own) return own;
  const legacy = await readStateFile(STATE_FILE);
  return legacy && legacy.bundlePath === bundlePath ? legacy : null;
}

export async function writeToolsServerState(state: ToolsServerState): Promise<void> {
  const target = stateFileForBundle(state.bundlePath);
  await mkdir(STATE_DIR, { recursive: true });
  // Atomic publish: write a per-process temp file, force 0600 (writeFile's
  // `mode` only applies on create, so chmod also covers a stale temp), then
  // rename over the state file. rename(2) within the same dir is atomic, so a
  // concurrent reader (another launcher, `argent server status`, the running
  // global MCP) never observes a missing / half-written / looser-perm state
  // file, and the auth token is never published at a world-readable mode.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Sync counterpart of {@link writeToolsServerState}. The CLI's foreground
 * `server start` path uses this to land the state file before any async
 * `child.on("exit")` event can fire, which would otherwise race the write
 * and leave a stale file pointing at a dead pid. Written 0600 to match the
 * async path (the state file may hold an auth token).
 */
export function writeToolsServerStateSync(state: ToolsServerState): void {
  const target = stateFileForBundle(state.bundlePath);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(target, 0o600);
}

/**
 * Remove the tracked state. With `bundlePath`, remove that install's per-bundle
 * file plus the legacy file when it records the same bundle; without, remove
 * the legacy file only.
 */
export async function clearToolsServerState(bundlePath?: string): Promise<void> {
  const files = [STATE_FILE];
  if (bundlePath !== undefined) {
    files[0] = stateFileForBundle(bundlePath);
    const legacy = await readStateFile(STATE_FILE);
    if (legacy && legacy.bundlePath === bundlePath) files.push(STATE_FILE);
  }
  for (const file of files) {
    try {
      await unlink(file);
    } catch {
      // already gone
    }
  }
}

const STATE_FILE_RE = /^tool-server(-[0-9a-f]{12})?\.json$/;

/**
 * Every tracked tool-server record: the legacy single-slot file plus all
 * per-bundle files. Dead-pid records are included — callers decide what a
 * stale entry means for them.
 */
export async function readAllToolsServerStates(): Promise<
  Array<{ file: string; state: ToolsServerState }>
> {
  let names: string[];
  try {
    names = await readdir(STATE_DIR);
  } catch {
    return [];
  }
  const out: Array<{ file: string; state: ToolsServerState }> = [];
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    const file = path.join(STATE_DIR, name);
    const state = await readStateFile(file);
    if (state) out.push({ file, state });
  }
  return out;
}

// Per-bundle files for installs that no longer run anything are junk left on
// disk (bundle paths change across versions under pnpm's store layout). Swept
// opportunistically from ensureToolsServer's slow path.
async function sweepDeadStateFiles(): Promise<void> {
  for (const { file } of await readAllToolsServerStates()) {
    if (file === STATE_FILE) continue; // legacy slot is handled by its owners
    // Re-read before unlinking: `argent server start --detach` writes without
    // the spawn lock, so a fresh LIVE record may have been rename()'d over
    // this slot since the snapshot. Deleting that would orphan a running
    // server — decide on the current contents.
    const fresh = await readStateFile(file);
    if (fresh && !isProcessAlive(fresh.pid)) await unlink(file).catch(() => {});
  }
}

const readState = readToolsServerState;
const writeState = writeToolsServerState;

// SIGTERM grace matches tool-server's own PROCESS_TIMEOUT_MS (5 s) plus a small
// buffer so we let the server's graceful shutdown (HTTP drain + registry
// dispose) finish before escalating. Without this wait, a fast restart can
// race the OS releasing the listening port and the next spawn hits EADDRINUSE.
const SIGTERM_GRACE_MS = 6_000;
const SIGKILL_GRACE_MS = 1_000;
const KILL_POLL_MS = 100;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((r) => setTimeout(r, KILL_POLL_MS));
  }
  return !isProcessAlive(pid);
}

/**
 * Stop a process: SIGTERM, wait out the graceful-shutdown window, then SIGKILL
 * if it's still up. No-op when the pid is already gone. Shared by
 * {@link killToolServer} and ensureToolsServer's kill-before-respawn so both
 * escalate identically.
 *
 * `stillOurs`, when provided, re-confirms the pid's identity immediately before
 * each signal. kill-before-respawn passes it so that if the pid is recycled onto
 * an unrelated process between the gate check and a signal (notably across the
 * multi-second SIGTERM grace window), we abort instead of killing a bystander.
 */
async function terminatePid(pid: number, stillOurs?: () => boolean): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (stillOurs && !stillOurs()) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Disappeared between the alive check and the signal — done.
    return;
  }
  if (await waitForExit(pid, SIGTERM_GRACE_MS)) return;
  // SIGTERM ignored or shutdown hung. Re-confirm identity (the pid could have
  // been recycled during the grace window) before the unconditional hard kill.
  if (stillOurs && !(isProcessAlive(pid) && stillOurs())) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForExit(pid, SIGKILL_GRACE_MS);
}

/**
 * Terminate the tracked tool-server and drop its record. With `bundlePath`,
 * scoped to THAT install's server; without, operates on the legacy
 * single-slot record only (backward-compat shape).
 */
export async function killToolServer(bundlePath?: string): Promise<void> {
  const state = await readState(bundlePath);
  if (!state) return;
  await terminatePid(state.pid);
  await clearToolsServerState(bundlePath ?? state.bundlePath);
}

function isPathWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Terminate every tracked tool-server whose bundle lives inside `packageDir`,
 * and drop their records. Teardown for `argent update` / `argent uninstall`:
 * they replace ONE install's files, so only that install's servers may be
 * killed — a different install's server may be serving another editor session.
 * Symlinked layouts (pnpm store, npm global prefix) are compared via realpath.
 * Returns the number of matching records cleaned up (servers terminated when
 * the pid still verifiably belongs to that install's tool-server).
 */
export async function killToolServerForInstallDir(packageDir: string): Promise<number> {
  const parents = new Set([path.resolve(packageDir), tryRealpath(packageDir)]);
  let killed = 0;
  for (const { file, state } of await readAllToolsServerStates()) {
    const bundles = new Set([path.resolve(state.bundlePath), tryRealpath(state.bundlePath)]);
    const matches = [...bundles].some((b) => [...parents].some((p) => isPathWithin(b, p)));
    if (!matches) continue;
    // The snapshot may be stale (another launcher can have republished this
    // slot since the read) — decide on the file's current contents so we never
    // kill/unlink a record we didn't match. Same reasoning as sweepDeadStateFiles.
    const fresh = await readStateFile(file);
    if (!fresh || fresh.pid !== state.pid || fresh.bundlePath !== state.bundlePath) continue;
    // Identity check before signalling: a long-lived record's pid may have
    // been recycled onto an unrelated process — same guard as the
    // wedged-server kill in ensureToolsServer. On Windows `ps` is unavailable
    // and the check always fails, so we keep the unguarded kill there rather
    // than silently never stopping servers during update/uninstall.
    const alive = isProcessAlive(fresh.pid);
    const guarded = process.platform !== "win32";
    if (alive && guarded && !processCommandMatches(fresh.pid, fresh.bundlePath)) {
      // Live pid we can't positively identify as this install's server: kill
      // nothing and KEEP the record — unlinking a merely-unparseable live
      // server would orphan it for `server stop`/status. A truly stale record
      // is swept once its pid dies.
      continue;
    }
    if (alive) {
      await terminatePid(
        fresh.pid,
        guarded ? () => processCommandMatches(fresh.pid, fresh.bundlePath) : undefined
      );
    }
    await unlink(file).catch(() => {});
    killed += 1;
  }
  return killed;
}

/**
 * Best-effort check that `pid` is one of OUR tool-server processes, by matching
 * its command line against `marker` (the bundle path recorded in state when we
 * spawned it). This guards kill-before-respawn against PID reuse: by the time
 * we respawn, the OS may have recycled a dead server's pid for an unrelated
 * process, which we must never signal. Returns false when the command line
 * can't be read (ps missing / unsupported platform) — fail safe, don't kill.
 */
function processCommandMatches(pid: number, marker: string | undefined): boolean {
  if (!marker) return false;
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!cmd) return false;
    // Structural match: our servers run `node <bundlePath> start`. Require the
    // bundle path at an argument boundary followed by `start` — not a bare
    // substring — so an unrelated process merely mentioning the path never
    // matches. Matched on the raw command string, not whitespace-split argv,
    // so a bundle path containing spaces still matches its own ps output.
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped} start(?:\\s|$)`).test(cmd);
  } catch {
    return false;
  }
}

// ── Cross-process spawn lock ──────────────────────────────────────────────
// ensureToolsServer's "is there a healthy server? no → spawn one" sequence is a
// read-modify-write across independent processes. Without serialization, two
// launchers (classically: an nvm node-version switch relaunches `argent mcp`
// under a new node while the previous MCP's health monitor reconnects) both
// observe "no server", both spawn a detached tool-server on its own free port,
// and the last writer to the state file orphans the rest. A simple O_EXCL lock
// file lets the kernel arbitrate so exactly one launcher spawns.
// Sized above the worst-case legitimate hold of the critical section, so a
// waiter never gives up (and proceeds unlocked) while a peer is still doing a
// real respawn: ~2s health + ~2s ps + 6s SIGTERM grace + 1s SIGKILL grace + 15s
// spawn ≈ 26s. STALE must exceed WAIT so a live-but-slow holder is never judged
// stale and stolen from underneath.
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 45_000;
const LOCK_POLL_MS = 100;

interface SpawnLock {
  release: () => void;
}

function spawnLockIsStale(): boolean {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as {
      pid?: number;
      ts?: number;
    };
    if (typeof pid === "number" && pid > 0 && !isProcessAlive(pid)) return true;
    if (typeof ts === "number" && Date.now() - ts > LOCK_STALE_MS) return true;
    return false;
  } catch {
    // Corrupt / half-written lock — fall back to its age on disk.
    try {
      return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true; // vanished underneath us — treat as unlocked
    }
  }
}

/**
 * Acquire the cross-process spawn lock. Returns a handle whose release() removes
 * the lock, or null when it can't be taken (unexpected FS error, or a peer held
 * it past LOCK_WAIT_TIMEOUT_MS). A null result means "proceed without the lock":
 * best-effort, so a missed lock at worst degrades to the pre-lock behavior and
 * never deadlocks ensureToolsServer.
 */
async function acquireSpawnLock(): Promise<SpawnLock | null> {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    return null;
  }
  // Per-acquisition nonce so release() can prove the on-disk lock is still the
  // one we wrote (and not a peer's, after a stale-steal under suspend/clock skew).
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      // wx === O_CREAT | O_EXCL | O_WRONLY: atomic "create iff absent".
      const fd = fs.openSync(LOCK_FILE, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, nonce, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still OURS. A stale-steal by a peer
          // could have replaced it; deleting that would free a lock we no longer
          // hold and let a third contender spawn concurrently.
          try {
            const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as {
              pid?: number;
              nonce?: string;
            };
            if (cur.pid === process.pid && cur.nonce === nonce) fs.unlinkSync(LOCK_FILE);
          } catch {
            /* unreadable / already gone — nothing safe to remove */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (spawnLockIsStale()) {
        // Holder died mid-spawn (or the lock is ancient). Try to reclaim it.
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* couldn't remove (perms / immutable / a peer beat us to it) */
        }
        // Reclaimed (file gone) → loop immediately to (re)create it. Still
        // present → we could NOT reclaim it; fall through to the bounded wait
        // below so a persistently-unremovable lock can never busy-spin the CPU.
        if (!fs.existsSync(LOCK_FILE)) continue;
      }
      if (Date.now() >= deadline) return null;
      await new Promise<void>((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

/**
 * Resolve a usable handle for the server described by `state`, or null when it
 * is absent, dead, or fails its health check. Side-effect free so both the
 * lock-free fast path and the double-check inside the lock can reuse it.
 *
 * When `wantBundlePath` is given, only a server running that SAME bundle is
 * reused — a different bundlePath is a different argent install, and reusing
 * it would silently run the wrong version. We return null so the caller spawns
 * its own; the other server is left running (another session may depend on it,
 * and the tools-client does not recover from a killed server).
 */
async function reusableHandle(
  state: ToolsServerState | null,
  wantBundlePath?: string,
  wantVersion?: string
): Promise<ToolsServerHandle | null> {
  if (!state || !isProcessAlive(state.pid)) return null;
  if (wantBundlePath !== undefined && state.bundlePath !== wantBundlePath) return null;
  // Same path, different version → the bundle was rewritten in place. The
  // authority is the DISK, read fresh: a server whose recorded version no
  // longer matches the on-disk package is running code that no longer exists
  // and must be retired, in BOTH directions (upgrade-only would keep a stale
  // server after a downgrade). Comparing disk-vs-state (not caller-vs-state)
  // also stops two long-lived sessions with different frozen versions from
  // ping-ponging SIGTERMs — both read the same disk. Only when the disk is
  // unreadable do we fall back to the caller's frozen version, and then only
  // in the caller-newer direction (self-heal without the ping-pong). A legacy
  // server with no recorded version is reused.
  if (wantBundlePath !== undefined && state.version !== undefined) {
    const diskVersion = readBundlePackageVersion(wantBundlePath);
    if (diskVersion !== undefined) {
      if (diskVersion !== state.version) return null;
    } else if (
      wantVersion !== undefined &&
      state.version !== wantVersion &&
      isVersionNewer(wantVersion, state.version)
    ) {
      return null;
    }
  }
  const host = state.host ?? "127.0.0.1";
  const healthy = await isToolsServerHealthy(state.port, host, 2000, state.token);
  if (!healthy) return null;
  return { url: formatUrl(healthCheckHost(host), state.port), token: state.token ?? "" };
}

export async function ensureToolsServer(paths: ToolsServerPaths): Promise<ToolsServerHandle> {
  // Fast path (the overwhelmingly common case): a healthy server running OUR
  // bundle is already tracked — reuse it without paying for the spawn lock.
  // Records are per bundle, so another install's server is neither considered
  // nor disturbed (see stateFileForBundle, reusableHandle).
  const fast = await reusableHandle(
    await readState(paths.bundlePath),
    paths.bundlePath,
    paths.version
  );
  if (fast) return fast;

  // Slow path: a spawn is likely needed. Serialize it across processes so the
  // churn from an nvm node-version switch can't let two launchers each spawn
  // their own detached tool-server and orphan all but the last.
  const lock = await acquireSpawnLock();
  try {
    // Double-checked: a peer may have spawned a healthy server (of our bundle)
    // while we waited for the lock. Reuse it rather than spawning a second one.
    const state = await readState(paths.bundlePath);
    const reuse = await reusableHandle(state, paths.bundlePath, paths.version);
    if (reuse) return reuse;

    // No usable server. If the tracked pid is a wedged/unhealthy server WE
    // auto-spawned FROM OUR OWN BUNDLE, terminate it BEFORE spawning the
    // replacement so it is never left running, untracked, on a leaked port. Four
    // guards keep this from signalling the wrong process:
    //   • managed === "autospawn" — never touch a `argent server start` (cli)
    //     server, which may be supervisor-managed and is just slow to start;
    //   • bundlePath === ours — never kill a *different* argent version's server
    //     (it may be healthy and serving another project's session);
    //   • a command-line identity match against the recorded bundle path;
    //   • terminatePid re-confirms that identity right before each signal.
    if (
      state &&
      state.managed === "autospawn" &&
      state.bundlePath === paths.bundlePath &&
      isProcessAlive(state.pid) &&
      processCommandMatches(state.pid, state.bundlePath)
    ) {
      await terminatePid(state.pid, () => processCommandMatches(state.pid, state.bundlePath));
    }
    // Retire only OUR OWN record — another install's must survive so its
    // server stays reachable by its owner. Also sweep per-bundle files whose
    // pid is gone, so retired installs don't accumulate junk in ~/.argent.
    await clearToolsServerState(paths.bundlePath);
    await sweepDeadStateFiles();

    // A bundle that no longer exists cannot be spawned: the install serving
    // this session was replaced by a layout that changes dirs across versions
    // (pnpm store prune) or removed outright. Fail with guidance instead of a
    // cryptic "exited before becoming ready" timeout.
    if (!fs.existsSync(paths.bundlePath)) {
      throw new Error(
        `The argent install serving this session is gone from disk (${paths.bundlePath}) — ` +
          `it was likely updated or removed. Restart the editor's MCP connection to reconnect.`
      );
    }

    // Spawn a new server with a fresh token. Auto-spawned servers always
    // authenticate (the token is local to this user and persisted 0600).
    //
    // Record the disk version, not the caller's import-time one (a stale
    // caller recording its own version would make the next disk-vs-state
    // comparison kill the server it just spawned). Reading BEFORE the spawn
    // keeps a mid-spawn in-place bump safe: the record carries the pre-bump
    // version, so the next call retires the old-code server — one redundant
    // respawn at worst, never a stale reuse.
    const diskVersion = readBundlePackageVersion(paths.bundlePath) ?? paths.version;
    const token = generateToken();
    const port = await findFreePort();
    const { port: actualPort, pid } = await spawnToolsServer(paths, port, {
      token,
      idleTimeoutMinutes: AUTOSPAWN_IDLE_TIMEOUT_MINUTES,
    });

    await writeState({
      port: actualPort,
      pid,
      startedAt: new Date().toISOString(),
      bundlePath: paths.bundlePath,
      version: diskVersion,
      host: "127.0.0.1",
      token,
      managed: "autospawn",
    });

    return { url: formatUrl("127.0.0.1", actualPort), token };
  } finally {
    lock?.release();
  }
}

export const STATE_PATHS = { STATE_DIR, STATE_FILE, LOG_FILE, LOCK_FILE };

export { formatUrl as formatToolsServerUrl };

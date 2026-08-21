import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { homedir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, unlink, rename, chmod } from "node:fs/promises";

const STATE_DIR = path.join(homedir(), ".argent");
// Legacy single-slot state file: read (and cleared) for older-argent compat,
// never written — each install now has its own file (see stateFileForBundle).
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");
// Cross-process mutex guarding ensureToolsServer's "decide whether to spawn,
// then spawn" critical section (see acquireSpawnLock).
const LOCK_FILE = path.join(STATE_DIR, "tool-server.lock");

const AUTH_TOKEN_BYTES = 32;
export const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";

// Idle shutdown for auto-spawned servers only; `argent server start` passes its
// own (0 = never).
const AUTOSPAWN_IDLE_TIMEOUT_MINUTES = 30;

/**
 * Filesystem locations needed to spawn tool-server. Provided by the consuming
 * package (`@swmansion/argent`), which knows where its bundle lives.
 */
export interface ToolsServerPaths {
  /** Path to the bundled tool-server.cjs */
  bundlePath: string;
  /** Directory containing the simulator-server binary */
  simulatorServerDir: string;
  /** Directory containing the native devtools dylibs */
  nativeDevtoolsDir: string;
  /**
   * Package version frozen at module import. Only a fallback: the version gate
   * re-reads the bundle's package.json on every call (see reusableHandle).
   */
  version?: string;
  /**
   * Project-local devDependency vs global PATH install, classified by the
   * consuming package while its cwd is still meaningful and exported as
   * ARGENT_INSTALL_KIND, so update-argent need not re-infer it from the
   * tool-server's editor-chosen cwd (often `/` or `$HOME`).
   */
  installKind?: "global" | "local";
  /**
   * For a local install, the project root holding the package. Exported as
   * ARGENT_PROJECT_ROOT so `argent update --local` pins the right project
   * instead of the tool-server's editor-chosen cwd.
   */
  installProjectRoot?: string;
}

export interface BuildToolsServerEnvOptions {
  /** Bind host. Omit to inherit the tool-server default (127.0.0.1). */
  host?: string;
  /** Idle-timeout minutes (0 disables). Omit to inherit the tool-server default. */
  idleTimeoutMinutes?: number;
  /**
   * Auth token, exported as `ARGENT_AUTH_TOKEN` so the tool-server enforces
   * `Authorization: Bearer <token>`. Omit (or pass empty) to run it
   * unauthenticated (`argent server start --no-auth`).
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
   * Version of the package that spawned this server. Absent in state files from
   * older versions, which reusableHandle reuses rather than forcing a respawn.
   */
  version?: string;
  /** Bind host. Absent in state files written by older versions. */
  host?: string;
  /**
   * Random token required as `Authorization: Bearer <token>` on every request.
   * Persisted 0600 so other users on the host can't read it. Absent when the
   * server runs unauthenticated (`argent server start --no-auth`).
   */
  token?: string;
  /**
   * Lifecycle owner. `autospawn` — spawned on demand by ensureToolsServer, safe
   * for that path to replace. `cli` — started by `argent server start`, possibly
   * supervisor-managed; the auto-spawn path must NOT terminate it. Absent on
   * legacy state files, which are treated as "not ours to kill".
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

/** Mint a tool-server auth token. Exposed for `argent server start`. */
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
 * True iff semver `a` is strictly newer than `b`, prereleases included —
 * truncating the tag would rank 0.14.0-rc.1 and 0.14.0-rc.2 equal and keep
 * reusing a stale server. Unparseable compares as "not newer", so the caller
 * reuses rather than kills.
 */
export function isVersionNewer(a: string, b: string): boolean {
  const parse = (v: string): { nums: number[]; pre: string[] } | null => {
    // Strip build metadata; split into numeric core + prerelease ids.
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
  // Equal core: per semver a release outranks its prereleases, and prerelease
  // ids compare field-by-field (numeric < alphanumeric; more fields wins a prefix).
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
 * On-disk version of the bundle's install, from the package.json one level
 * above its dist/ dir. Never cached: `paths.version` is frozen at import, which
 * would leave a long-lived MCP process blind to in-place bumps or downgrades.
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

/** Wildcard bind hosts (`0.0.0.0`, `::`) cannot be connected to; use loopback. */
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
    // Only the status matters, and an unread body keeps undici's keep-alive
    // socket ref'd until the server closes it, hanging a natural-exit CLI
    // command (`argent run …`, `argent tools`) seconds after it printed.
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
   * Ms to wait for the "listening" banner. Defaults to
   * {@link SPAWN_READY_TIMEOUT_MS}; exposed so tests can exercise the
   * kill-on-timeout path without a 15s wait.
   */
  readyTimeoutMs?: number;
}

const SPAWN_READY_TIMEOUT_MS = 15_000;

/**
 * SIGKILL the child's whole process group: it is spawned `detached`, so it
 * leads its own group and `kill(-pid)` reaps anything it spawned too.
 * Best-effort — the child may already be gone.
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

    // Reject AND reap: the child is detached + unref'd, so a bare reject leaves
    // it to bind its port seconds later as an untracked orphan.
    const rejectAndKill = (err: Error) =>
      settle(() => {
        killSpawnedChild(child, pid);
        reject(err);
      });

    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      // Greedy `.+` backtracks to the trailing `:port`, so hostnames, IPv4 and
      // bracketed IPv6 (`[::1]`) all match.
      const match = line.match(/Tools server listening on http:\/\/.+:(\d+)/);
      if (match) {
        const actualPort = parseInt(match[1]!, 10);
        rl.close();
        // Keep the pipe draining so the child's writes don't back up once
        // readline stops consuming it.
        child.stdout?.resume();
        // ...but unref the pipe: `child.unref()` detaches only the process
        // handle, and the still-ref'd stdout pipe would hang a short-lived
        // caller like `argent run <tool>` forever on a drained-but-open pipe.
        // At runtime it is a net.Socket with unref(); the ChildProcess type
        // widens it to Readable, hence the narrowing.
        (child.stdout as { unref?: () => void } | null)?.unref?.();
        settle(() => resolve({ port: actualPort, pid }));
      }
    });

    child.on("error", (err) => {
      rl.close();
      // A spawn-level error (ENOENT/EACCES) usually means no child exists; the
      // kill is a no-op then, but reaps a half-started one.
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
 * Per-bundle state file: each install has a distinct bundlePath and so its own
 * slot, so spawning one install's server never clobbers another's record and
 * orphans that server.
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
 * With `bundlePath`, THAT install's record: per-bundle file first, then the
 * legacy single-slot file when it records the same bundle. Without, the legacy
 * file only.
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
  // Atomic publish via per-process temp + rename(2), so a concurrent reader
  // never observes a missing / half-written / looser-perm file holding the auth
  // token. chmod as well as `mode`, which only applies when writeFile creates.
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
 * Sync counterpart of {@link writeToolsServerState}, for the CLI's foreground
 * `server start`: a fast child exit must not race the write and leave a stale
 * file pointing at a dead pid. 0600 — the state may hold an auth token.
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
 * With `bundlePath`, remove that install's per-bundle file plus the legacy file
 * when it records the same bundle; without, the legacy file only.
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
 * Every tracked record: the legacy single-slot file plus all per-bundle files.
 * Dead-pid records included — callers decide what a stale entry means.
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

// Swept opportunistically from ensureToolsServer's slow path: records for
// installs that no longer run anything are junk (bundle paths change across
// versions), and a LIVE server whose recorded bundle is GONE from disk can
// never serve current code again (version-pinned install dirs are replaced
// wholesale on upgrade, stranding that server at a dead path).
export async function sweepDeadStateFiles(): Promise<void> {
  for (const { file } of await readAllToolsServerStates()) {
    if (file === STATE_FILE) continue; // legacy slot is handled by its owners
    // Re-read before acting: `argent server start --detach` writes without the
    // spawn lock, so a fresh LIVE record may have been rename()'d over this slot
    // since the snapshot, and deleting it would orphan a running server.
    const fresh = await readStateFile(file);
    if (!fresh) continue;
    if (!isProcessAlive(fresh.pid)) {
      await unlink(file).catch(() => {});
      continue;
    }
    if (fs.existsSync(fresh.bundlePath)) continue;
    // Same identity guard as killToolServerForInstallDir: never signal a
    // recycled pid, and keep an unidentifiable-but-live record reachable by
    // `server stop`/status (swept once its pid dies). On Windows `ps` is
    // unavailable and the check always fails, so the kill stays unguarded there
    // rather than never retiring dead-bundle servers.
    const guarded = process.platform !== "win32";
    if (guarded && !processCommandMatches(fresh.pid, fresh.bundlePath)) continue;
    // Unlink first, then terminate WITHOUT awaiting the grace window: the sweep
    // runs under the spawn lock while a session waits for tools, so a wedged
    // orphan must not add its multi-second SIGTERM grace to that wait.
    // terminatePid delivers the guarded SIGTERM synchronously before its first
    // await and never rejects; only the SIGKILL escalation outlives this call,
    // and its pending poll keeps a short-lived process alive until it lands.
    await unlink(file).catch(() => {});
    void terminatePid(
      fresh.pid,
      guarded ? () => processCommandMatches(fresh.pid, fresh.bundlePath) : undefined
    );
  }
}

const readState = readToolsServerState;
const writeState = writeToolsServerState;

// Matches tool-server's own PROCESS_TIMEOUT_MS (5 s) plus a buffer, so its
// graceful shutdown finishes before we escalate; otherwise a fast restart races
// the OS releasing the listening port and the next spawn hits EADDRINUSE.
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
 * SIGTERM, wait out the graceful-shutdown window, then SIGKILL if still up.
 * No-op when the pid is already gone.
 *
 * `stillOurs` re-confirms the pid's identity immediately before each signal, so
 * a pid recycled onto an unrelated process (notably across the multi-second
 * SIGTERM grace window) aborts the kill instead of hitting a bystander.
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
  // SIGTERM ignored or shutdown hung. Re-confirm identity: the pid could have
  // been recycled during the grace window.
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
 * THAT install's server; without, the legacy single-slot record only.
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
 * Terminate every tracked tool-server whose bundle lives inside `packageDir`
 * and drop their records. Teardown for `argent update` / `argent uninstall`,
 * scoped to the one install they replace — a different install's server may be
 * serving another editor session. Symlinked layouts are compared via realpath.
 * Returns the number of records cleaned up (killed only when the pid still
 * verifiably belongs to that install's tool-server).
 */
export async function killToolServerForInstallDir(packageDir: string): Promise<number> {
  const parents = new Set([path.resolve(packageDir), tryRealpath(packageDir)]);
  let killed = 0;
  for (const { file, state } of await readAllToolsServerStates()) {
    const bundles = new Set([path.resolve(state.bundlePath), tryRealpath(state.bundlePath)]);
    const matches = [...bundles].some((b) => [...parents].some((p) => isPathWithin(b, p)));
    if (!matches) continue;
    // The snapshot may be stale (another launcher can have republished this
    // slot), so decide on the file's current contents and never kill/unlink a
    // record we didn't match. Same reasoning as sweepDeadStateFiles.
    const fresh = await readStateFile(file);
    if (!fresh || fresh.pid !== state.pid || fresh.bundlePath !== state.bundlePath) continue;
    // A long-lived record's pid may have been recycled onto an unrelated
    // process. On Windows `ps` is unavailable and the check always fails, so we
    // keep the unguarded kill there rather than silently never stopping servers
    // during update/uninstall.
    const alive = isProcessAlive(fresh.pid);
    const guarded = process.platform !== "win32";
    if (alive && guarded && !processCommandMatches(fresh.pid, fresh.bundlePath)) {
      // Unidentifiable live pid: keep the record, since unlinking a live
      // server orphans it for `server stop`/status. A truly stale record is
      // swept once its pid dies.
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
 * Best-effort check that `pid` is one of OUR tool-servers, matching its command
 * line against `marker` (the bundle path recorded when we spawned it). Guards
 * kills against PID reuse. Returns false when the command line can't be read
 * (ps missing / unsupported platform) — fail safe, don't kill.
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
    // Our servers run `node <bundlePath> start`. Requiring the path at an
    // argument boundary followed by `start` keeps an unrelated process that
    // merely mentions it from matching; matching the raw command string rather
    // than split argv keeps bundle paths containing spaces working.
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped} start(?:\\s|$)`).test(cmd);
  } catch {
    return false;
  }
}

// ensureToolsServer's "is there a healthy server? no → spawn one" is a
// read-modify-write across independent processes. Without serialization two
// launchers both observe "no server", both spawn a detached tool-server on its
// own free port, and the last writer to the state file orphans the rest. An
// O_EXCL lock file lets the kernel arbitrate so exactly one launcher spawns.
// Sized above the worst-case legitimate hold of the critical section (~2s health
// + ~2s ps + 6s SIGTERM grace + 1s SIGKILL grace + 15s spawn ≈ 26s), so a waiter
// never proceeds unlocked while a peer is mid-respawn. STALE must exceed WAIT so
// a live-but-slow holder is never judged stale and stolen from underneath.
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
 * Acquire the spawn lock. Null when it can't be taken (FS error, or a peer held
 * it past LOCK_WAIT_TIMEOUT_MS) and the caller should proceed WITHOUT it: the
 * lock is best-effort and must never deadlock ensureToolsServer.
 */
async function acquireSpawnLock(): Promise<SpawnLock | null> {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    return null;
  }
  // Per-acquisition nonce so release() can tell our lock from a peer's, after a
  // stale-steal under suspend / clock skew.
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
          // Only remove the lock if it is still OURS: after a peer's
          // stale-steal, deleting it would let a third contender spawn too.
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
        // Reclaimed → loop and recreate it. Still present → fall through to the
        // bounded wait below, so an unremovable lock can't busy-spin the CPU.
        if (!fs.existsSync(LOCK_FILE)) continue;
      }
      if (Date.now() >= deadline) return null;
      await new Promise<void>((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

/**
 * Handle for the server described by `state`, or null when it is absent, dead,
 * or fails its health check. Side-effect free, so both the lock-free fast path
 * and the double-check inside the lock can use it.
 *
 * With `wantBundlePath`, only a server running that SAME bundle is reused — a
 * different bundlePath is a different install, and reusing it would silently
 * run the wrong version. The caller spawns its own and leaves that server up:
 * another session may depend on it, and the tools-client does not recover from
 * a killed server.
 */
async function reusableHandle(
  state: ToolsServerState | null,
  wantBundlePath?: string,
  wantVersion?: string
): Promise<ToolsServerHandle | null> {
  if (!state || !isProcessAlive(state.pid)) return null;
  if (wantBundlePath !== undefined && state.bundlePath !== wantBundlePath) return null;
  // Same path, different version → the bundle was rewritten in place, so the
  // server runs code that no longer exists and must be retired in BOTH
  // directions (upgrade-only would keep a stale server after a downgrade).
  // Comparing disk-vs-state rather than caller-vs-state also stops two
  // long-lived sessions with different frozen versions from ping-ponging
  // SIGTERMs. Only when the disk is unreadable do we fall back to the caller's
  // frozen version, and then only when it is newer. A server with no recorded
  // version is reused.
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
  // Fast path: a healthy server running OUR bundle is already tracked — reuse
  // it without paying for the spawn lock. Records are per bundle, so another
  // install's server is neither considered nor disturbed.
  const fast = await reusableHandle(
    await readState(paths.bundlePath),
    paths.bundlePath,
    paths.version
  );
  if (fast) return fast;

  // Slow path: a spawn is likely needed. Serialize it across processes so two
  // launchers can't each spawn their own detached tool-server and orphan all
  // but the last.
  const lock = await acquireSpawnLock();
  try {
    // A peer may have spawned a healthy server of our bundle while we waited.
    const state = await readState(paths.bundlePath);
    const reuse = await reusableHandle(state, paths.bundlePath, paths.version);
    if (reuse) return reuse;

    // Kill a wedged server WE auto-spawned from OUR OWN bundle before spawning
    // its replacement, so it is never left running, untracked, on a leaked port.
    // Guards against signalling the wrong process:
    //   • managed === "autospawn" — never a `argent server start` (cli) server,
    //     which may be supervisor-managed and is just slow to start;
    //   • bundlePath === ours — never a different version's server, which may be
    //     healthy and serving another project's session;
    //   • a command-line identity match, re-confirmed by terminatePid right
    //     before each signal.
    if (
      state &&
      state.managed === "autospawn" &&
      state.bundlePath === paths.bundlePath &&
      isProcessAlive(state.pid) &&
      processCommandMatches(state.pid, state.bundlePath)
    ) {
      await terminatePid(state.pid, () => processCommandMatches(state.pid, state.bundlePath));
    }
    // Retire only OUR OWN record — another install's must survive so its server
    // stays reachable by its owner. The sweep then clears per-bundle files whose
    // pid is gone or whose bundle was deleted from disk.
    await clearToolsServerState(paths.bundlePath);
    await sweepDeadStateFiles();

    // A missing bundle means the install serving this session was replaced (a
    // layout that changes dirs across versions) or removed outright. Fail with
    // guidance instead of a cryptic "exited before becoming ready" timeout.
    if (!fs.existsSync(paths.bundlePath)) {
      throw new Error(
        `The argent install serving this session is gone from disk (${paths.bundlePath}) — ` +
          `it was likely updated or removed. Restart the editor's MCP connection to reconnect.`
      );
    }

    // Auto-spawned servers always authenticate; the token is local to this user
    // and persisted 0600.
    //
    // Record the DISK version, not the caller's import-time one, or a stale
    // caller would make the next disk-vs-state comparison kill the server it
    // just spawned. Reading BEFORE the spawn keeps a mid-spawn in-place bump
    // safe: the record carries the pre-bump version, so the next call retires
    // the old-code server — one redundant respawn at worst, never a stale reuse.
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

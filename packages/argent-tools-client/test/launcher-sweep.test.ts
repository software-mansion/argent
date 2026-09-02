import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The launcher captures STATE_DIR from `homedir()` at module load. Redirect
// HOME to a per-file temp dir BEFORE the dynamic import runs so the entire
// state-file API operates against an isolated sandbox.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;
let STATE_DIR: string;
let LEGACY_STATE_FILE: string;
const ambientHome: Record<string, string | undefined> = {};

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-sweep-test-"));
  // Captured for afterAll, which puts them back before deleting TEST_HOME —
  // anything left pointing at it resolves to a directory that is gone.
  for (const name of ["HOME", "USERPROFILE"]) ambientHome[name] = process.env[name];
  // os.homedir() — which STATE_DIR and the link file are built from — reads
  // USERPROFILE on Windows and HOME elsewhere, so pin both or the redirect
  // is inert there and these tests operate on the real ~/.argent.
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  STATE_DIR = launcher.STATE_PATHS.STATE_DIR;
  LEGACY_STATE_FILE = launcher.STATE_PATHS.STATE_FILE;
  expect(LEGACY_STATE_FILE.startsWith(TEST_HOME)).toBe(true);
});

afterAll(() => {
  for (const [name, value] of Object.entries(ambientHome)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

// A pid that can never be alive (max int32 - 1) so kill paths only exercise
// record cleanup, never signal a real process.
const DEAD_PID = 2_147_483_646;

const baseState = {
  port: 49502,
  startedAt: "2026-07-15T17:00:00.000Z",
  host: "127.0.0.1",
};

function writeRecord(bundlePath: string, pid: number): string {
  const file = launcher.stateFileForBundle(bundlePath);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...baseState, pid, bundlePath }, null, 2) + "\n", "utf8");
  return file;
}

/** Spawn a keepalive child running `node <bundlePath> start`, exactly the
 * command shape the launcher's identity check requires. Resolves once the
 * child has printed its ready marker, so callers may delete the bundle file
 * without racing node's module load. With `trapSigterm`, the child installs a
 * no-op SIGTERM handler BEFORE printing ready, simulating a wedged server.
 * `args` replaces the trailing `start`, for the processes the guard must NOT
 * mistake for a server. */
async function spawnFakeServer(
  bundlePath: string,
  opts?: { trapSigterm?: boolean; args?: string[] }
): Promise<ChildProcess> {
  writeFileSync(
    bundlePath,
    (opts?.trapSigterm ? 'process.on("SIGTERM", () => {});\n' : "") +
      'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);\n',
    "utf8"
  );
  const child = spawn("node", [bundlePath, ...(opts?.args ?? ["start"])], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", () => reject(new Error("fake server exited before becoming ready")));
  });
  return child;
}

/** Does this platform's `ps` clip `-o command=` to $COLUMNS? procps-ng does;
 * BSD `ps` clips only to a terminal width, and the guard never hands `ps` a
 * terminal — so the width regression is unobservable on macOS. Probed against a
 * live pid through the guard's own reader (so a change to its flags reaches the
 * probe) rather than assumed from `process.platform`. A `ps` that rejects the
 * reader's flags cannot answer either way, which is the guard's own verdict
 * too — report "does not clip" so the caller skips instead of erroring. */
function psClipsToColumns(pid: number): boolean {
  try {
    return (
      launcher.readProcessCommandLine(pid, []).length < launcher.readProcessCommandLine(pid).length
    );
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("sweepDeadStateFiles", () => {
  it("unlinks a per-bundle record whose pid is dead", async () => {
    const file = writeRecord("/gone/install/dist/tool-server.cjs", DEAD_PID);
    await launcher.sweepDeadStateFiles();
    expect(existsSync(file)).toBe(false);
  });

  it("keeps a live server whose bundle still exists on disk", async () => {
    const bundle = join(TEST_HOME, "live-bundle.cjs");
    const child = await spawnFakeServer(bundle);
    const file = writeRecord(bundle, child.pid!);
    try {
      await launcher.sweepDeadStateFiles();
      expect(existsSync(file)).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("terminates a live server whose bundle is GONE and unlinks its record (the old postinstall job)", async () => {
    const bundle = join(TEST_HOME, "replaced-bundle.cjs");
    const child = await spawnFakeServer(bundle);
    const file = writeRecord(bundle, child.pid!);
    // Simulate a pnpm/yarn upgrade replacing the version-pinned install dir:
    // the running server's bundle path no longer exists.
    rmSync(bundle);
    try {
      await launcher.sweepDeadStateFiles();
      expect(await waitForExit(child)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("terminates a live server whose bundle path is longer than the terminal is wide", async (ctx) => {
    // The identity guard reads the process command line with `ps`, and procps-ng
    // clips `-o command=` to $COLUMNS unless `-ww` is passed. A bundle path that
    // does not fit the width must still match its own marker; otherwise the
    // guard fails safe and the sweep leaves the server running forever.
    const NARROW_COLUMNS = 40;
    // procps's single `-w` widens to max($COLUMNS, 132) rather than lifting the
    // limit, so an argv under that floor cannot tell `-ww` from a one-character
    // regression to `-w`. Size the fixture past it.
    const PS_SINGLE_W_FLOOR = 132;
    const bundle = join(
      TEST_HOME,
      "a-bundle-path-wider-than-both-a-narrow-terminal-and-the-column-floor-that-a-single-w-widens-to-instead-of-lifting.cjs"
    );
    // Precondition, not decoration: a command line short enough to survive
    // truncation matches however `ps` is invoked, making this test vacuous.
    expect(`node ${bundle} start`.length).toBeGreaterThan(PS_SINGLE_W_FLOOR);
    const child = await spawnFakeServer(bundle);
    const file = writeRecord(bundle, child.pid!);
    rmSync(bundle);
    // `ps` inherits this process's environment, so COLUMNS fixes the width it
    // reports at, independent of the terminal the suite happens to run under.
    const ambientColumns = process.env.COLUMNS;
    process.env.COLUMNS = String(NARROW_COLUMNS);
    try {
      // Skip rather than pass vacuously: where `ps` ignores $COLUMNS the
      // assertions below hold whether or not the guard passes `-ww`.
      if (!psClipsToColumns(child.pid!)) ctx.skip();
      await launcher.sweepDeadStateFiles();
      expect(await waitForExit(child)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (ambientColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = ambientColumns;
      child.kill("SIGKILL");
    }
    // waitForExit's own window exceeds vitest's 5 s default, so a server the
    // guard failed to identify reports as an unterminated server rather than
    // as a bare test timeout.
  }, 20_000);

  it("terminates a live server when PATH omits every directory holding `ps`", async () => {
    // An MCP server launched from a GUI / launchd context inherits a sanitized
    // PATH without `/bin`, where a bare `ps` spawn ENOENTs. The identity guard
    // must still read the command line there, or it fails safe and the sweep
    // leaves the server running forever.
    const bundle = join(TEST_HOME, "sanitized-path-bundle.cjs");
    const child = await spawnFakeServer(bundle);
    const file = writeRecord(bundle, child.pid!);
    rmSync(bundle);
    const ambientPath = process.env.PATH;
    process.env.PATH = join(TEST_HOME, "no-such-bin");
    try {
      await launcher.sweepDeadStateFiles();
      expect(await waitForExit(child)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (ambientPath === undefined) delete process.env.PATH;
      else process.env.PATH = ambientPath;
      child.kill("SIGKILL");
    }
  }, 20_000);

  // `-ww` hands the guard whole command lines, so the structural match is the
  // only thing standing between a look-alike and a SIGTERM. Both halves of it
  // and the reach of its argument boundary are pinned below, and each test
  // records a bundle path that is NOT on disk — the sweep short-circuits on one
  // that is, never reaching the guard.

  it("does not signal a process that merely mentions the bundle path", async () => {
    const marker = join(TEST_HOME, "gone-install/dist/tool-server.cjs");
    const watcher = join(TEST_HOME, "watcher.cjs");
    expect(existsSync(marker)).toBe(false);
    // Carries the recorded path in its argv, but is not running it: the guard
    // requires a following `start`, so this must survive untouched.
    const child = await spawnFakeServer(watcher, { args: [marker] });
    const file = writeRecord(marker, child.pid!);
    try {
      await launcher.sweepDeadStateFiles();
      // A signal is only ever sent after the record is unlinked, so a
      // surviving record is itself "nothing was signalled".
      expect(existsSync(file)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("does not signal a different install whose bundle path ends with ours", async () => {
    // A second install nested under a longer prefix: its command line contains
    // the recorded path followed by `start`, and only the leading argument
    // boundary tells the two apart. Killing it would take down a server another
    // session is using.
    const marker = "/retired-install/dist/tool-server.cjs";
    const impostor = TEST_HOME + marker;
    expect(existsSync(marker)).toBe(false);
    mkdirSync(dirname(impostor), { recursive: true });
    const child = await spawnFakeServer(impostor);
    const file = writeRecord(marker, child.pid!);
    try {
      await launcher.sweepDeadStateFiles();
      expect(existsSync(file)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("signals a shell wrapper whose script embeds our launch line mid-argv", async () => {
    // The match is a substring rule anchored at argument boundaries, so a
    // command line that contains `<bundle> start` anywhere — here inside a
    // `sh -c` script — reads as ours. Requiring it at argv[1] instead would
    // stop identifying any launch that puts the bundle later (a `node --flag`,
    // an `env` prefix, a supervisor's wrapper) and orphan that server, which is
    // the outcome every fallback in this guard leans away from.
    const marker = join(TEST_HOME, "wrapped-install/dist/tool-server.cjs");
    expect(existsSync(marker)).toBe(false);
    // `node <marker> start` fails instantly (no such module) with its output
    // discarded; `ready` follows it so the shell is in its final shape by the
    // time the sweep looks. The trailing `:` is load bearing: dash execs the
    // LAST command of a `-c` script in place, and the process ps reports would
    // be `sleep 30`, the wrapper's argv gone.
    const child = spawn(
      "/bin/sh",
      ["-c", `node ${marker} start >/dev/null 2>&1; echo ready; sleep 30; :`],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("exit", () => reject(new Error("shell wrapper exited before becoming ready")));
    });
    expect(launcher.readProcessCommandLine(child.pid!)).toContain(`${marker} start`);
    const file = writeRecord(marker, child.pid!);
    try {
      await launcher.sweepDeadStateFiles();
      expect(await waitForExit(child)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);

  it("terminates a live server whose bundle path is full of regex metacharacters", async () => {
    // The marker is spliced into a RegExp, so an install dir like `c++` or
    // `foo(v1)` must reach the match as literals — quantifiers or classes loose
    // in the pattern would make a server never match its own record.
    const bundle = join(TEST_HOME, "c++(v1)+tool-server[1].cjs");
    const child = await spawnFakeServer(bundle);
    const file = writeRecord(bundle, child.pid!);
    rmSync(bundle);
    try {
      await launcher.sweepDeadStateFiles();
      expect(await waitForExit(child)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);

  it("returns without waiting out the kill grace window on a SIGTERM-ignoring orphan", async () => {
    const bundle = join(TEST_HOME, "wedged-bundle.cjs");
    const child = await spawnFakeServer(bundle, { trapSigterm: true });
    const file = writeRecord(bundle, child.pid!);
    rmSync(bundle);
    try {
      // The sweep runs under ensureToolsServer's spawn lock, so it must not
      // block on the multi-second SIGTERM grace of a wedged orphan: the
      // record is unlinked and the guarded SIGTERM delivered, but the sweep
      // returns while the orphan (which trapped the signal) is still alive —
      // the SIGKILL escalation happens in the background.
      await launcher.sweepDeadStateFiles();
      expect(existsSync(file)).toBe(false);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("keeps a live record it cannot positively identify as a tool-server (recycled pid)", async () => {
    // This vitest process is alive but its command line is not
    // `node <bundle> start`, so the identity guard must refuse to signal it.
    const file = writeRecord("/gone/other-install/dist/tool-server.cjs", process.pid);
    await launcher.sweepDeadStateFiles();
    expect(existsSync(file)).toBe(true);
  });

  it("never touches the legacy single-slot record", async () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      LEGACY_STATE_FILE,
      JSON.stringify({ ...baseState, pid: DEAD_PID, bundlePath: "/gone/legacy.cjs" }) + "\n",
      "utf8"
    );
    await launcher.sweepDeadStateFiles();
    expect(existsSync(LEGACY_STATE_FILE)).toBe(true);
  });
});

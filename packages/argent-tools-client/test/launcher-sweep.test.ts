import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launcher captures STATE_DIR from `homedir()` at module load. Redirect
// HOME to a per-file temp dir BEFORE the dynamic import runs so the entire
// state-file API operates against an isolated sandbox.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;
let STATE_DIR: string;
let LEGACY_STATE_FILE: string;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-sweep-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  STATE_DIR = launcher.STATE_PATHS.STATE_DIR;
  LEGACY_STATE_FILE = launcher.STATE_PATHS.STATE_FILE;
  expect(LEGACY_STATE_FILE.startsWith(TEST_HOME)).toBe(true);
});

afterAll(() => {
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
 * without racing node's module load. */
async function spawnFakeServer(bundlePath: string): Promise<ChildProcess> {
  writeFileSync(
    bundlePath,
    'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);\n',
    "utf8"
  );
  const child = spawn("node", [bundlePath, "start"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", () => reject(new Error("fake server exited before becoming ready")));
  });
  return child;
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

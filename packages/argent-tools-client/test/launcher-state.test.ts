import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-state-test-"));
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

const BUNDLE = "/some/path/tool-server.cjs";
const OTHER_BUNDLE = "/some/OTHER/install/dist/tool-server.cjs";

// A pid that can never be alive (max int32 - 1) so kill paths only exercise
// record cleanup, never signal a real process.
const DEAD_PID = 2_147_483_646;

const sampleState = {
  port: 49502,
  pid: 12345,
  startedAt: "2026-05-11T17:00:00.000Z",
  bundlePath: BUNDLE,
  host: "127.0.0.1",
};

function writeLegacy(state: object): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEGACY_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

describe("writeToolsServerState ↔ readToolsServerState round-trip (per-bundle)", () => {
  it("persists every documented field under the bundle's own state file", async () => {
    await launcher.writeToolsServerState(sampleState);
    expect(existsSync(launcher.stateFileForBundle(BUNDLE))).toBe(true);
    expect(existsSync(LEGACY_STATE_FILE)).toBe(false); // new code never writes the legacy slot
    expect(await launcher.readToolsServerState(BUNDLE)).toEqual(sampleState);
  });

  it("creates the state directory if it does not exist", async () => {
    await launcher.writeToolsServerState(sampleState);
    expect(existsSync(launcher.stateFileForBundle(BUNDLE))).toBe(true);
  });

  it("overwrites prior state on subsequent writes", async () => {
    await launcher.writeToolsServerState(sampleState);
    await launcher.writeToolsServerState({ ...sampleState, port: 9999 });
    const read = await launcher.readToolsServerState(BUNDLE);
    expect(read?.port).toBe(9999);
  });

  it("keeps records for different bundles in independent slots", async () => {
    await launcher.writeToolsServerState(sampleState);
    await launcher.writeToolsServerState({ ...sampleState, bundlePath: OTHER_BUNDLE, port: 555 });
    expect((await launcher.readToolsServerState(BUNDLE))?.port).toBe(sampleState.port);
    expect((await launcher.readToolsServerState(OTHER_BUNDLE))?.port).toBe(555);
  });
});

describe("writeToolsServerStateSync", () => {
  it("produces byte-identical content to the async writer (drop-in replacement)", async () => {
    const stateFile = launcher.stateFileForBundle(BUNDLE);
    await launcher.writeToolsServerState(sampleState);
    const asyncBytes = readFileSync(stateFile);
    await launcher.clearToolsServerState(BUNDLE);

    launcher.writeToolsServerStateSync(sampleState);
    const syncBytes = readFileSync(stateFile);

    expect(syncBytes.equals(asyncBytes)).toBe(true);
  });

  it("commits to disk before returning (the foreground race-fix invariant)", () => {
    launcher.writeToolsServerStateSync(sampleState);
    // Sync read immediately afterwards must succeed — this is the contract
    // that lets runForeground() avoid the stale-pid race when a child exits
    // synchronously (e.g. EADDRINUSE).
    const raw = JSON.parse(readFileSync(launcher.stateFileForBundle(BUNDLE), "utf8"));
    expect(raw).toEqual(sampleState);
  });
});

describe("readToolsServerState — failure modes & legacy compat", () => {
  it("returns null when no state file exists", async () => {
    expect(await launcher.readToolsServerState()).toBeNull();
    expect(await launcher.readToolsServerState(BUNDLE)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", async () => {
    writeLegacy({});
    writeFileSync(LEGACY_STATE_FILE, "{ this is not json }", "utf8");
    expect(await launcher.readToolsServerState()).toBeNull();
    expect(await launcher.readToolsServerState(BUNDLE)).toBeNull();
  });

  it("argless read returns the legacy single-slot record (backward-compat)", async () => {
    const legacy = {
      port: 1234,
      pid: 5678,
      startedAt: "2025-01-01T00:00:00.000Z",
      bundlePath: "/legacy/tool-server.cjs",
    };
    writeLegacy(legacy);
    const read = await launcher.readToolsServerState();
    expect(read).toMatchObject(legacy);
    expect(read?.host).toBeUndefined();
  });

  it("bundle-scoped read falls back to a legacy record for the SAME bundle only", async () => {
    writeLegacy({ ...sampleState, bundlePath: BUNDLE });
    expect(await launcher.readToolsServerState(BUNDLE)).toMatchObject({ bundlePath: BUNDLE });
    expect(await launcher.readToolsServerState(OTHER_BUNDLE)).toBeNull();
  });

  it("the bundle's own record wins over a legacy record", async () => {
    writeLegacy({ ...sampleState, port: 1111 });
    await launcher.writeToolsServerState({ ...sampleState, port: 2222 });
    expect((await launcher.readToolsServerState(BUNDLE))?.port).toBe(2222);
  });
});

describe("clearToolsServerState", () => {
  it("removes the bundle's state file", async () => {
    await launcher.writeToolsServerState(sampleState);
    expect(existsSync(launcher.stateFileForBundle(BUNDLE))).toBe(true);
    await launcher.clearToolsServerState(BUNDLE);
    expect(existsSync(launcher.stateFileForBundle(BUNDLE))).toBe(false);
  });

  it("also removes a legacy record for the same bundle — and only for the same bundle", async () => {
    writeLegacy(sampleState);
    await launcher.clearToolsServerState(OTHER_BUNDLE);
    expect(existsSync(LEGACY_STATE_FILE)).toBe(true);
    await launcher.clearToolsServerState(BUNDLE);
    expect(existsSync(LEGACY_STATE_FILE)).toBe(false);
  });

  it("argless clear removes the legacy file only", async () => {
    writeLegacy(sampleState);
    await launcher.writeToolsServerState({ ...sampleState, bundlePath: OTHER_BUNDLE });
    await launcher.clearToolsServerState();
    expect(existsSync(LEGACY_STATE_FILE)).toBe(false);
    expect(existsSync(launcher.stateFileForBundle(OTHER_BUNDLE))).toBe(true);
  });

  it("is a no-op when the file is already gone (idempotent)", async () => {
    await expect(launcher.clearToolsServerState(BUNDLE)).resolves.toBeUndefined();
    await expect(launcher.clearToolsServerState(BUNDLE)).resolves.toBeUndefined();
  });
});

describe("readAllToolsServerStates", () => {
  it("returns every per-bundle record plus the legacy slot", async () => {
    writeLegacy({ ...sampleState, bundlePath: "/legacy/tool-server.cjs" });
    await launcher.writeToolsServerState(sampleState);
    await launcher.writeToolsServerState({ ...sampleState, bundlePath: OTHER_BUNDLE });
    const all = await launcher.readAllToolsServerStates();
    expect(all.map(({ state }) => state.bundlePath).sort()).toEqual(
      ["/legacy/tool-server.cjs", BUNDLE, OTHER_BUNDLE].sort()
    );
  });

  it("returns [] when the state dir does not exist", async () => {
    expect(await launcher.readAllToolsServerStates()).toEqual([]);
  });
});

describe("killToolServer — empty state cases", () => {
  it("is a no-op when no state file exists", async () => {
    await expect(launcher.killToolServer()).resolves.toBeUndefined();
    await expect(launcher.killToolServer(BUNDLE)).resolves.toBeUndefined();
  });

  it("clears state pointing at a long-dead pid without throwing", async () => {
    await launcher.writeToolsServerState({ ...sampleState, pid: DEAD_PID });
    await launcher.killToolServer(BUNDLE);
    expect(await launcher.readToolsServerState(BUNDLE)).toBeNull();
  });

  it("scoped kill leaves a different bundle's record untouched", async () => {
    await launcher.writeToolsServerState({ ...sampleState, pid: DEAD_PID });
    await launcher.writeToolsServerState({
      ...sampleState,
      bundlePath: OTHER_BUNDLE,
      pid: DEAD_PID,
    });
    await launcher.killToolServer(BUNDLE);
    expect(await launcher.readToolsServerState(BUNDLE)).toBeNull();
    expect(await launcher.readToolsServerState(OTHER_BUNDLE)).not.toBeNull();
  });
});

describe("killToolServerForInstallDir", () => {
  it("removes records whose bundle lives inside the install dir — and no others", async () => {
    const installDir = join(TEST_HOME, "project", "node_modules", "@swmansion", "argent");
    const ownBundle = join(installDir, "dist", "tool-server.cjs");
    await launcher.writeToolsServerState({ ...sampleState, bundlePath: ownBundle, pid: DEAD_PID });
    await launcher.writeToolsServerState({
      ...sampleState,
      bundlePath: OTHER_BUNDLE,
      pid: DEAD_PID,
    });
    writeLegacy({ ...sampleState, bundlePath: ownBundle, pid: DEAD_PID });

    const killed = await launcher.killToolServerForInstallDir(installDir);

    // Both records for this install (per-bundle + legacy) are gone; the
    // unrelated install's record survives.
    expect(killed).toBe(2);
    expect(await launcher.readToolsServerState(ownBundle)).toBeNull();
    expect(existsSync(LEGACY_STATE_FILE)).toBe(false);
    expect(await launcher.readToolsServerState(OTHER_BUNDLE)).not.toBeNull();
  });

  it("returns 0 when nothing matches", async () => {
    await launcher.writeToolsServerState({ ...sampleState, pid: DEAD_PID });
    expect(await launcher.killToolServerForInstallDir("/nowhere/else")).toBe(0);
    expect(await launcher.readToolsServerState(BUNDLE)).not.toBeNull();
  });

  // win32 has no `ps`, so the guard is deliberately disabled there — this test
  // would SIGTERM the test runner itself.
  it.skipIf(process.platform === "win32")(
    "keeps the record and signals nothing when a LIVE pid cannot be identified as ours",
    async () => {
      // Use this test process's own pid: alive, but its command line is the
      // vitest runner — not `node <bundle> start` — so the identity guard must
      // refuse to signal it AND must leave the record in place (unlinking would
      // orphan a live server whose ps output we merely failed to parse).
      const installDir = join(TEST_HOME, "proj2", "node_modules", "@swmansion", "argent");
      const ownBundle = join(installDir, "dist", "tool-server.cjs");
      await launcher.writeToolsServerState({
        ...sampleState,
        bundlePath: ownBundle,
        pid: process.pid,
      });

      const killed = await launcher.killToolServerForInstallDir(installDir);

      expect(killed).toBe(0);
      expect(await launcher.readToolsServerState(ownBundle)).not.toBeNull();
    }
  );
});

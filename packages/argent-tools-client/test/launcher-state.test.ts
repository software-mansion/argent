import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launcher captures STATE_DIR from `homedir()` at module load. Redirect
// HOME to a per-file temp dir BEFORE the dynamic import runs so the entire
// state-file API operates against an isolated sandbox.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;
let STATE_FILE: string;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-state-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  STATE_FILE = launcher.STATE_PATHS.STATE_FILE;
  expect(STATE_FILE.startsWith(TEST_HOME)).toBe(true);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(async () => {
  await launcher.clearToolsServerState();
});

const sampleState = {
  port: 49502,
  pid: 12345,
  startedAt: "2026-05-11T17:00:00.000Z",
  bundlePath: "/some/path/tool-server.cjs",
  host: "127.0.0.1",
};

describe("writeToolsServerState ↔ readToolsServerState round-trip", () => {
  it("persists every documented field, including the new `host`", async () => {
    await launcher.writeToolsServerState(sampleState);
    const read = await launcher.readToolsServerState();
    expect(read).toEqual(sampleState);
  });

  it("creates the state directory if it does not exist", async () => {
    rmSync(join(TEST_HOME, ".argent"), { recursive: true, force: true });
    await launcher.writeToolsServerState(sampleState);
    expect(existsSync(STATE_FILE)).toBe(true);
  });

  it("overwrites prior state on subsequent writes", async () => {
    await launcher.writeToolsServerState(sampleState);
    await launcher.writeToolsServerState({ ...sampleState, port: 9999 });
    const read = await launcher.readToolsServerState();
    expect(read?.port).toBe(9999);
  });
});

describe("writeToolsServerStateSync", () => {
  it("produces byte-identical content to the async writer (drop-in replacement)", async () => {
    await launcher.writeToolsServerState(sampleState);
    const asyncBytes = readFileSync(STATE_FILE);
    await launcher.clearToolsServerState();

    launcher.writeToolsServerStateSync(sampleState);
    const syncBytes = readFileSync(STATE_FILE);

    expect(syncBytes.equals(asyncBytes)).toBe(true);
  });

  it("commits to disk before returning (the foreground race-fix invariant)", () => {
    launcher.writeToolsServerStateSync(sampleState);
    // Sync read immediately afterwards must succeed — this is the contract
    // that lets runForeground() avoid the stale-pid race when a child exits
    // synchronously (e.g. EADDRINUSE).
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    expect(raw).toEqual(sampleState);
  });
});

describe("readToolsServerState — failure modes", () => {
  it("returns null when the state file does not exist", async () => {
    expect(await launcher.readToolsServerState()).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", async () => {
    writeFileSync(STATE_FILE, "{ this is not json }", "utf8");
    expect(await launcher.readToolsServerState()).toBeNull();
  });

  it("parses legacy state files written without the `host` field (backward-compat)", async () => {
    const legacy = {
      port: 1234,
      pid: 5678,
      startedAt: "2025-01-01T00:00:00.000Z",
      bundlePath: "/legacy/tool-server.cjs",
    };
    writeFileSync(STATE_FILE, JSON.stringify(legacy, null, 2) + "\n", "utf8");
    const read = await launcher.readToolsServerState();
    expect(read).toMatchObject(legacy);
    expect(read?.host).toBeUndefined();
  });
});

describe("clearToolsServerState", () => {
  it("removes the state file", async () => {
    await launcher.writeToolsServerState(sampleState);
    expect(existsSync(STATE_FILE)).toBe(true);
    await launcher.clearToolsServerState();
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it("is a no-op when the file is already gone (idempotent)", async () => {
    await expect(launcher.clearToolsServerState()).resolves.toBeUndefined();
    await expect(launcher.clearToolsServerState()).resolves.toBeUndefined();
  });
});

describe("killToolServer — empty state cases", () => {
  it("is a no-op when no state file exists", async () => {
    await expect(launcher.killToolServer()).resolves.toBeUndefined();
  });

  it("clears state pointing at a long-dead pid without throwing", async () => {
    await launcher.writeToolsServerState({ ...sampleState, pid: 2_147_483_646 });
    await launcher.killToolServer();
    expect(await launcher.readToolsServerState()).toBeNull();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The launcher's version gate decides reuse-vs-respawn from the CURRENT
// ON-DISK bundle version (read fresh from the package.json above the bundle),
// not from the caller's import-time version. These tests stage a real package
// layout (<pkg>/package.json + <pkg>/dist/tool-server.cjs) so the disk read
// resolves, and cover the three directions the frozen-caller rule got wrong:
// downgrades, prerelease bumps, and a stale caller vs. a current server.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;

const FIXTURE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

let pkgDir: string;
let bundlePath: string;

function stageDiskVersion(version: string): void {
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-argent", version }));
}

const paths = (callerVersion: string): import("../src/launcher.js").ToolsServerPaths => ({
  bundlePath,
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
  version: callerVersion,
});

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-version-gate-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  pkgDir = join(TEST_HOME, "pkg");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  bundlePath = join(pkgDir, "dist", "tool-server.cjs");
  copyFileSync(FIXTURE_BUNDLE, bundlePath);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const spawnedPids: number[] = [];
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  rmSync(launcher.STATE_PATHS.STATE_DIR, { recursive: true, force: true });
});

async function waitForDeath(pid: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && launcher.isToolsServerProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function spawnTracked(recordedVersion: string): Promise<{ pid: number; port: number }> {
  const server = await launcher.spawnToolsServer(
    paths(recordedVersion),
    await launcher.findFreePort(),
    { token: "gate-token" }
  );
  spawnedPids.push(server.pid);
  await launcher.writeToolsServerState({
    port: server.port,
    pid: server.pid,
    startedAt: new Date().toISOString(),
    bundlePath,
    version: recordedVersion,
    host: "127.0.0.1",
    token: "gate-token",
    managed: "autospawn",
  });
  return server;
}

describe("ensureToolsServer — disk-version gate", () => {
  it(
    "retires the tracked server after an on-disk DOWNGRADE, even though the caller is not newer",
    { timeout: 30_000 },
    async () => {
      // A team downgrades away from a bad release (--ignore-scripts, so no
      // postinstall kill). The tracked 2.0.0 server must be retired: the code
      // it runs no longer exists on disk. The caller is ALSO frozen at 2.0.0,
      // so the old caller-is-newer rule would have kept reusing the bad server.
      stageDiskVersion("1.0.0");
      const old = await spawnTracked("2.0.0");

      const handle = await launcher.ensureToolsServer(paths("2.0.0"));

      await waitForDeath(old.pid);
      expect(launcher.isToolsServerProcessAlive(old.pid)).toBe(false);
      const state = await launcher.readToolsServerState(bundlePath);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(old.pid);
      // The record carries what the new server actually runs: the disk version.
      expect(state!.version).toBe("1.0.0");
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
    }
  );

  it(
    "retires the tracked server after a PRERELEASE bump (rc.1 -> rc.2)",
    { timeout: 30_000 },
    async () => {
      stageDiskVersion("1.0.0-rc.2");
      const old = await spawnTracked("1.0.0-rc.1");

      await launcher.ensureToolsServer(paths("1.0.0-rc.2"));

      await waitForDeath(old.pid);
      expect(launcher.isToolsServerProcessAlive(old.pid)).toBe(false);
      const state = await launcher.readToolsServerState(bundlePath);
      expect(state!.version).toBe("1.0.0-rc.2");
      spawnedPids.push(state!.pid);
    }
  );

  it(
    "reuses a current server even when THIS caller is frozen at an older version",
    { timeout: 30_000 },
    async () => {
      // A long-lived MCP session that started before the bump: the disk and the
      // tracked server agree (2.0.0), only the caller is stale (1.0.0). Reuse —
      // both sessions read the same disk, so neither tears the other down (the
      // ping-pong the old rule guarded against, now without going version-blind).
      stageDiskVersion("2.0.0");
      const current = await spawnTracked("2.0.0");

      const handle = await launcher.ensureToolsServer(paths("1.0.0"));

      expect(launcher.isToolsServerProcessAlive(current.pid)).toBe(true);
      const state = await launcher.readToolsServerState(bundlePath);
      expect(state!.pid).toBe(current.pid);
      expect(handle.token).toBe("gate-token");
    }
  );
});

describe("isVersionNewer — prerelease-aware precedence", () => {
  it("orders numeric cores", () => {
    expect(launcher.isVersionNewer("1.2.3", "1.2.2")).toBe(true);
    expect(launcher.isVersionNewer("1.2.2", "1.2.3")).toBe(false);
    expect(launcher.isVersionNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("a release outranks its own prereleases", () => {
    expect(launcher.isVersionNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(launcher.isVersionNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });

  it("orders prerelease identifiers per semver", () => {
    expect(launcher.isVersionNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(launcher.isVersionNewer("1.0.0-rc.1", "1.0.0-rc.2")).toBe(false);
    expect(launcher.isVersionNewer("1.0.0-rc.10", "1.0.0-rc.9")).toBe(true);
    expect(launcher.isVersionNewer("1.0.0-rc.1.1", "1.0.0-rc.1")).toBe(true);
    expect(launcher.isVersionNewer("1.0.0-rc", "1.0.0-alpha")).toBe(true);
    // Numeric identifiers rank below alphanumeric ones.
    expect(launcher.isVersionNewer("1.0.0-alpha", "1.0.0-1")).toBe(true);
    expect(launcher.isVersionNewer("1.0.0-1", "1.0.0-alpha")).toBe(false);
  });

  it("ignores build metadata and treats unparseable input as not newer", () => {
    expect(launcher.isVersionNewer("1.0.1+build5", "1.0.0")).toBe(true);
    expect(launcher.isVersionNewer("garbage", "1.0.0")).toBe(false);
    expect(launcher.isVersionNewer("1.0.0", "garbage")).toBe(false);
  });
});

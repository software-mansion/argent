import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Same HOME-redirection pattern as launcher-state.test.ts so killToolServer
// reads/writes the per-file isolated state directory and never touches the
// developer's real ~/.argent.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;

const FAKE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

const fakePaths = (): import("../src/launcher.js").ToolsServerPaths => ({
  bundlePath: FAKE_BUNDLE,
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
});

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-spawn-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  expect(existsSync(FAKE_BUNDLE)).toBe(true);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// Ensure no stray children survive a failing test.
const spawnedPids: number[] = [];
afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  await launcher.clearToolsServerState();
});

async function trackedSpawn(
  port = 0,
  options: import("../src/launcher.js").SpawnToolsServerOptions = {}
) {
  const free = port === 0 ? await launcher.findFreePort() : port;
  const result = await launcher.spawnToolsServer(fakePaths(), free, options);
  spawnedPids.push(result.pid);
  return result;
}

describe("spawnToolsServer", () => {
  it("resolves with the bound port and pid once the ready banner appears", async () => {
    const requested = await launcher.findFreePort();
    const { port, pid } = await trackedSpawn(requested);

    expect(port).toBe(requested);
    expect(pid).toBeGreaterThan(0);
    expect(launcher.isToolsServerProcessAlive(pid)).toBe(true);
  });

  it("propagates host into the child via ARGENT_HOST and serves /tools there", async () => {
    const requested = await launcher.findFreePort();
    const { port } = await trackedSpawn(requested, { host: "127.0.0.1" });

    const healthy = await launcher.isToolsServerHealthy(port, "127.0.0.1", 2000);
    expect(healthy).toBe(true);
  });

  it("rejects if the child exits before printing the ready banner", async () => {
    process.env.FAKE_MODE = "exit-immediate";
    try {
      await expect(trackedSpawn()).rejects.toThrow(/exited with code 7/);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });
});

describe("killToolServer — full lifecycle", () => {
  it("graceful shutdown: SIGTERM stops the child and clears the state file", async () => {
    const { port, pid } = await trackedSpawn();
    await launcher.writeToolsServerState({
      port,
      pid,
      startedAt: new Date().toISOString(),
      bundlePath: FAKE_BUNDLE,
      host: "127.0.0.1",
    });

    expect(launcher.isToolsServerProcessAlive(pid)).toBe(true);

    await launcher.killToolServer();

    expect(launcher.isToolsServerProcessAlive(pid)).toBe(false);
    expect(await launcher.readToolsServerState()).toBeNull();
  });

  it(
    "escalates to SIGKILL when the child swallows SIGTERM (the EADDRINUSE-restart fix)",
    { timeout: 20_000 },
    async () => {
      process.env.FAKE_IGNORE_SIGTERM = "1";
      let pid: number;
      try {
        const spawned = await trackedSpawn();
        pid = spawned.pid;
        await launcher.writeToolsServerState({
          port: spawned.port,
          pid,
          startedAt: new Date().toISOString(),
          bundlePath: FAKE_BUNDLE,
          host: "127.0.0.1",
        });
      } finally {
        delete process.env.FAKE_IGNORE_SIGTERM;
      }

      const start = Date.now();
      await launcher.killToolServer();
      const elapsed = Date.now() - start;

      expect(launcher.isToolsServerProcessAlive(pid)).toBe(false);
      expect(await launcher.readToolsServerState()).toBeNull();
      // SIGTERM grace is 6s; SIGKILL must arrive after that. Loose upper
      // bound prevents flaky failures on slow CI hosts.
      expect(elapsed).toBeGreaterThanOrEqual(5_500);
      expect(elapsed).toBeLessThan(15_000);
    }
  );

  it("clears state when the recorded pid is already dead before killToolServer is called", async () => {
    const { pid } = await trackedSpawn();
    process.kill(pid, "SIGKILL");
    // Wait for the OS to reap the process so isProcessAlive flips to false.
    for (let i = 0; i < 50 && launcher.isToolsServerProcessAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await launcher.writeToolsServerState({
      port: 1,
      pid,
      startedAt: new Date().toISOString(),
      bundlePath: FAKE_BUNDLE,
      host: "127.0.0.1",
    });

    await launcher.killToolServer();
    expect(await launcher.readToolsServerState()).toBeNull();
  });
});

describe("ensureToolsServer", () => {
  it("reuses the already-running server reported by the state file", async () => {
    const first = await launcher.ensureToolsServer(fakePaths());
    spawnedPids.push((await launcher.readToolsServerState())!.pid);

    const second = await launcher.ensureToolsServer(fakePaths());

    expect(second).toBe(first);
    const state = await launcher.readToolsServerState();
    expect(state?.pid).toBe(spawnedPids[0]);
  });

  it("treats a stale state file (dead pid) as 'no server' and respawns", async () => {
    await launcher.writeToolsServerState({
      port: 1,
      pid: 2_147_483_646,
      startedAt: "2025-01-01T00:00:00.000Z",
      bundlePath: FAKE_BUNDLE,
      host: "127.0.0.1",
    });

    const url = await launcher.ensureToolsServer(fakePaths());
    const fresh = await launcher.readToolsServerState();
    expect(fresh).not.toBeNull();
    expect(fresh!.pid).not.toBe(2_147_483_646);
    expect(launcher.isToolsServerProcessAlive(fresh!.pid)).toBe(true);
    spawnedPids.push(fresh!.pid);

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await launcher.isToolsServerHealthy(fresh!.port, "127.0.0.1")).toBe(true);
  });
});

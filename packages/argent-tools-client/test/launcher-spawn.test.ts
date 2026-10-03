import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

// Same HOME-redirection pattern as launcher-state.test.ts so killToolServer
// reads/writes the per-file isolated state directory and never touches the
// developer's real ~/.argent.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;
let restoreHome: () => void;

const FAKE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

const fakePaths = (): import("../src/launcher.js").ToolsServerPaths => ({
  bundlePath: FAKE_BUNDLE,
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
});

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-spawn-test-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  expect(existsSync(FAKE_BUNDLE)).toBe(true);
});

afterAll(() => {
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const spawnedPids: number[] = [];
// TTL safety net. The reaper below can only kill a pid that reached
// `spawnedPids`, and every site records one only after the spawn has already
// happened — so an assertion throwing in between leaves a real server running
// while this same hook deletes the record that could find it. Sixty seconds
// outlasts the longest test here (30s) and expires well before the next run.
beforeEach(() => {
  process.env.FAKE_TTL_MS = "60000";
});
afterEach(async () => {
  delete process.env.FAKE_TTL_MS;
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  await launcher.clearToolsServerState(FAKE_BUNDLE);
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

  it("rejects with a clear message instead of crashing when `node` is not on PATH", async () => {
    // Pose as Bun so the launcher falls back to `node` on PATH, then empty PATH.
    const savedBun = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { value: "1.0.0", configurable: true });
    const savedPath = process.env.PATH;
    process.env.PATH = TEST_HOME;
    try {
      await expect(trackedSpawn()).rejects.toThrow(
        "Could not start the argent tool-server: `node` was not found on PATH."
      );
    } finally {
      process.env.PATH = savedPath;
      if (savedBun) Object.defineProperty(process.versions, "bun", savedBun);
      else delete (process.versions as Record<string, string>).bun;
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

    expect(await launcher.killToolServer(FAKE_BUNDLE)).toBe(true);

    expect(launcher.isToolsServerProcessAlive(pid)).toBe(false);
    expect(await launcher.readToolsServerState(FAKE_BUNDLE)).toBeNull();
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
      await launcher.killToolServer(FAKE_BUNDLE);
      const elapsed = Date.now() - start;

      expect(launcher.isToolsServerProcessAlive(pid)).toBe(false);
      expect(await launcher.readToolsServerState(FAKE_BUNDLE)).toBeNull();
      // SIGTERM grace is 6s; SIGKILL must arrive after that. Loose upper
      // bound prevents flaky failures on slow CI hosts.
      expect(elapsed).toBeGreaterThanOrEqual(5_500);
      expect(elapsed).toBeLessThan(15_000);
    }
  );

  // The launcher reads ps in this locale; a host without it (glibc with no
  // C.UTF-8 installed) has no UTF-8 locale left to render the path in.
  const hasForcedLocale = (() => {
    if (process.platform === "win32") return true;
    try {
      const charmap = execFileSync("locale", ["charmap"], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return charmap.trim() === "UTF-8";
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasForcedLocale)(
    "stops a server under a non-ASCII path when the caller has no UTF-8 locale",
    async () => {
      // Outside a UTF-8 locale ps escapes non-ASCII bytes (`M-E` on macOS, `?`
      // on procps), so the identity guard must not depend on the caller's one.
      const dir = mkdtempSync(join(tmpdir(), "argent-zażółć-"));
      const bundlePath = join(dir, "tool-server.cjs");
      copyFileSync(FAKE_BUNDLE, bundlePath);
      const saved = {
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        LC_CTYPE: process.env.LC_CTYPE,
      };
      try {
        const { port, pid } = await launcher.spawnToolsServer(
          { ...fakePaths(), bundlePath },
          await launcher.findFreePort()
        );
        spawnedPids.push(pid);
        await launcher.writeToolsServerState({
          port,
          pid,
          startedAt: new Date().toISOString(),
          bundlePath,
          host: "127.0.0.1",
        });
        delete process.env.LANG;
        delete process.env.LC_CTYPE;
        process.env.LC_ALL = "C";

        expect(await launcher.killToolServer(bundlePath)).toBe(true);

        expect(launcher.isToolsServerProcessAlive(pid)).toBe(false);
        expect(await launcher.readToolsServerState(bundlePath)).toBeNull();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  // win32 has no `ps`, so the guard is deliberately disabled there.
  it.skipIf(process.platform === "win32")(
    "leaves alone a process whose bundle path follows a no-break space",
    async () => {
      // ps joins argv with plain spaces; a UTF-8 read must not let a no-break
      // space inside another program's argv pass for that boundary.
      const decoy = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", `xx\u00a0${FAKE_BUNDLE}`, "start"],
        { stdio: "ignore" }
      );
      spawnedPids.push(decoy.pid!);
      await launcher.writeToolsServerState({
        port: 1,
        pid: decoy.pid!,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
      });
      const savedLcAll = process.env.LC_ALL;
      try {
        for (const lcAll of ["C", "en_US.UTF-8"]) {
          process.env.LC_ALL = lcAll;
          expect(await launcher.killToolServer(FAKE_BUNDLE)).toBe(false);
        }
      } finally {
        if (savedLcAll === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = savedLcAll;
      }
      expect(launcher.isToolsServerProcessAlive(decoy.pid!)).toBe(true);
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

    expect(await launcher.killToolServer(FAKE_BUNDLE)).toBe(false);
    expect(await launcher.readToolsServerState(FAKE_BUNDLE)).toBeNull();
  });
});

describe("ensureToolsServer", () => {
  it("reuses the already-running server reported by the state file", async () => {
    const first = await launcher.ensureToolsServer(fakePaths());
    spawnedPids.push((await launcher.readToolsServerState(FAKE_BUNDLE))!.pid);

    const second = await launcher.ensureToolsServer(fakePaths());

    // ensureToolsServer returns a fresh handle each call; on reuse the url +
    // token are derived from the same state file, so compare by value.
    expect(second).toEqual(first);
    const state = await launcher.readToolsServerState(FAKE_BUNDLE);
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

    const handle = await launcher.ensureToolsServer(fakePaths());
    const fresh = await launcher.readToolsServerState(FAKE_BUNDLE);
    expect(fresh).not.toBeNull();
    expect(fresh!.pid).not.toBe(2_147_483_646);
    expect(launcher.isToolsServerProcessAlive(fresh!.pid)).toBe(true);
    spawnedPids.push(fresh!.pid);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await launcher.isToolsServerHealthy(fresh!.port, "127.0.0.1")).toBe(true);
  });

  it("binds the child to 127.0.0.1 even when ARGENT_HOST names another address", async () => {
    // ::1 is IPv6-loopback only, so a child that took the export would not
    // answer on the 127.0.0.1 the handle and the state file both promise.
    process.env.ARGENT_HOST = "::1";
    try {
      const handle = await launcher.ensureToolsServer(fakePaths());
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      spawnedPids.push(state!.pid);

      expect(handle.url).toBe(`http://127.0.0.1:${state!.port}`);
      expect(await launcher.isToolsServerHealthy(state!.port, "127.0.0.1")).toBe(true);
    } finally {
      delete process.env.ARGENT_HOST;
    }
  });
});

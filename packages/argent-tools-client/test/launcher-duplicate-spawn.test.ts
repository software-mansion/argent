import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Regression coverage for the "two tool-servers alive at once after an nvm
// node-version switch" bug. Switching node versions makes the host relaunch
// `argent mcp` under a new node while the previous MCP's health monitor
// reconnects, so several launchers call ensureToolsServer at nearly the same
// time. Before the fix each one spawned its own detached tool-server and
// orphaned all but the last (the live system was seen running three).
//
// Same HOME-redirection pattern as launcher-spawn.test.ts so the launcher's
// state file + spawn lock live in an isolated sandbox, never the developer's
// real ~/.argent.
let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;

const FAKE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

const fakePaths = (): import("../src/launcher.js").ToolsServerPaths => ({
  bundlePath: FAKE_BUNDLE,
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
});

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-dup-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  expect(existsSync(FAKE_BUNDLE)).toBe(true);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// Track every pid we create so a failing assertion can never strand a server.
const spawnedPids: number[] = [];
afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  // Per-bundle registry: wipe every record (FAKE_BUNDLE, the foreign-bundle
  // slot some tests create, and the legacy file) so no test leaks into the next.
  rmSync(launcher.STATE_PATHS.STATE_DIR, { recursive: true, force: true });
});

async function waitForDeath(pid: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && launcher.isToolsServerProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ensureToolsServer — duplicate-spawn prevention (nvm node-version switch)", () => {
  it(
    "collapses a burst of concurrent launches into a single tool-server",
    { timeout: 30_000 },
    async () => {
      // TTL safety net: if the lock regressed and a duplicate leaked, it
      // self-exits instead of stranding a long-lived process on the host.
      process.env.FAKE_TTL_MS = "60000";
      let handles: Awaited<ReturnType<typeof launcher.ensureToolsServer>>[];
      try {
        handles = await Promise.all(
          Array.from({ length: 5 }, () => launcher.ensureToolsServer(fakePaths()))
        );
      } finally {
        delete process.env.FAKE_TTL_MS;
      }

      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      spawnedPids.push(state!.pid);

      // Every racer must resolve to the SAME server — distinct URLs would mean
      // more than one tool-server got spawned (the bug).
      const urls = new Set(handles.map((h) => h.url));
      expect(urls.size).toBe(1);
      expect([...urls][0]).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));

      // And that one server is the live, healthy one.
      expect(launcher.isToolsServerProcessAlive(state!.pid)).toBe(true);
      expect(
        await launcher.isToolsServerHealthy(state!.port, "127.0.0.1", 2000, state!.token)
      ).toBe(true);
    }
  );

  it(
    "terminates an alive-but-unhealthy tracked server instead of orphaning it on respawn",
    { timeout: 30_000 },
    async () => {
      // Stand up a server that is alive but fails /tools (the wedged-after-switch
      // shape), and record it in state as the tracked server.
      process.env.FAKE_MODE = "unhealthy";
      let wedged: { port: number; pid: number };
      try {
        wedged = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
          token: "wedged-token",
        });
      } finally {
        delete process.env.FAKE_MODE;
      }
      spawnedPids.push(wedged.pid);
      await launcher.writeToolsServerState({
        port: wedged.port,
        pid: wedged.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
        token: "wedged-token",
        managed: "autospawn",
      });
      expect(launcher.isToolsServerProcessAlive(wedged.pid)).toBe(true);

      const handle = await launcher.ensureToolsServer(fakePaths());

      // The wedged server must be gone — not left running on a leaked port.
      await waitForDeath(wedged.pid);
      expect(launcher.isToolsServerProcessAlive(wedged.pid)).toBe(false);

      // A fresh, healthy server has taken its place and is the one tracked.
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(wedged.pid);
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
      expect(await launcher.isToolsServerHealthy(state!.port, "127.0.0.1")).toBe(true);
    }
  );

  it(
    "never signals a recycled pid: leaves an unrelated process alive when identity doesn't match",
    { timeout: 30_000 },
    async () => {
      // Emulate PID reuse: the recorded pid is alive but is NOT a tool-server
      // (its command line doesn't contain the recorded bundle path). The
      // respawn must spawn a fresh server WITHOUT signalling the bystander.
      const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
        stdio: "ignore",
      });
      const bystanderPid = bystander.pid!;
      spawnedPids.push(bystanderPid);
      expect(launcher.isToolsServerProcessAlive(bystanderPid)).toBe(true);

      await launcher.writeToolsServerState({
        port: 1, // nothing listens here → health check fails fast
        pid: bystanderPid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
        token: "stale-token",
      });

      const handle = await launcher.ensureToolsServer(fakePaths());

      // Bystander untouched.
      expect(launcher.isToolsServerProcessAlive(bystanderPid)).toBe(true);

      // A fresh healthy server exists and is tracked.
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(bystanderPid);
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
      expect(await launcher.isToolsServerHealthy(state!.port, "127.0.0.1")).toBe(true);
    }
  );

  it(
    "leaves a CLI-managed (`argent server start`) server alive instead of killing it on respawn",
    { timeout: 30_000 },
    async () => {
      // A user/supervisor started this server explicitly; even while it is still
      // unhealthy (e.g. mid-bind) the auto-spawn path must NEVER terminate it.
      process.env.FAKE_MODE = "unhealthy";
      let cli: { port: number; pid: number };
      try {
        cli = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
          token: "cli-token",
        });
      } finally {
        delete process.env.FAKE_MODE;
      }
      spawnedPids.push(cli.pid);
      await launcher.writeToolsServerState({
        port: cli.port,
        pid: cli.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
        token: "cli-token",
        managed: "cli",
      });

      const handle = await launcher.ensureToolsServer(fakePaths());

      // The CLI server must still be running — never signalled.
      expect(launcher.isToolsServerProcessAlive(cli.pid)).toBe(true);

      // A separate auto-spawned server now backs the returned handle and is tracked.
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(cli.pid);
      expect(state!.managed).toBe("autospawn");
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
    }
  );

  it(
    "reaps the spawned child when readiness times out, so no orphan binds its port",
    { timeout: 20_000 },
    async () => {
      // no-ready mode binds but never prints the ready banner, so spawnToolsServer
      // hits its readiness timeout and rejects WITHOUT returning a pid. The
      // detached child must be killed on that path — otherwise it would bind its
      // port moments later as an untracked second server (the exact bug).
      const pidfile = join(TEST_HOME, "noready.pid");
      process.env.FAKE_MODE = "no-ready";
      process.env.FAKE_PIDFILE = pidfile;
      try {
        await expect(
          launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
            readyTimeoutMs: 1_500,
          })
        ).rejects.toThrow(/Timed out/);
      } finally {
        delete process.env.FAKE_MODE;
        delete process.env.FAKE_PIDFILE;
      }

      const childPid = parseInt(readFileSync(pidfile, "utf8"), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      spawnedPids.push(childPid); // belt-and-suspenders cleanup if the assert fails
      await waitForDeath(childPid, 4_000);
      expect(launcher.isToolsServerProcessAlive(childPid)).toBe(false);
    }
  );

  // Committable / repo-local install mode: distinct installs (global vs a
  // repo-local devDependency) have distinct bundlePaths. A client must only
  // reuse a server running ITS OWN bundle, and must not kill another install's
  // server — a different session may be using it and can't recover from a kill.
  it(
    "does not reuse a healthy server from a DIFFERENT bundle; spawns its own and leaves the other alive",
    { timeout: 30_000 },
    async () => {
      const other = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
        token: "other-token",
      });
      spawnedPids.push(other.pid);
      // Record it under a DIFFERENT bundlePath (a different install/version).
      await launcher.writeToolsServerState({
        port: other.port,
        pid: other.pid,
        startedAt: new Date().toISOString(),
        bundlePath: "/some/OTHER/install/dist/tool-server.cjs",
        host: "127.0.0.1",
        token: "other-token",
        managed: "autospawn",
      });
      expect(
        await launcher.isToolsServerHealthy(other.port, "127.0.0.1", 2000, "other-token")
      ).toBe(true);

      const handle = await launcher.ensureToolsServer(fakePaths());

      // The other-bundle server is left ALIVE — never killed.
      expect(launcher.isToolsServerProcessAlive(other.pid)).toBe(true);

      // We spawned our OWN server, tracked under OUR bundlePath, on a new port.
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(other.pid);
      expect(state!.bundlePath).toBe(FAKE_BUNDLE);
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
      expect(handle.url).not.toBe(launcher.formatToolsServerUrl("127.0.0.1", other.port));

      // The other install's record SURVIVES — a single shared slot would leave
      // that server running but untracked (unreachable by `argent server stop`,
      // killToolServer, or the postinstall kill).
      const otherState = await launcher.readToolsServerState(
        "/some/OTHER/install/dist/tool-server.cjs"
      );
      expect(otherState).not.toBeNull();
      expect(otherState!.pid).toBe(other.pid);
    }
  );

  it(
    "reuses a healthy same-bundle server recorded in the LEGACY single-slot file (pre-registry compat)",
    { timeout: 30_000 },
    async () => {
      const existing = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
        token: "legacy-token",
      });
      spawnedPids.push(existing.pid);
      // Simulate a record written by an older argent version: the legacy
      // tool-server.json, not a per-bundle file.
      const legacy = {
        port: existing.port,
        pid: existing.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
        token: "legacy-token",
        managed: "autospawn",
      };
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(launcher.STATE_PATHS.STATE_DIR, { recursive: true });
      writeFileSync(launcher.STATE_PATHS.STATE_FILE, JSON.stringify(legacy));

      const handle = await launcher.ensureToolsServer(fakePaths());

      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", existing.port));
      expect(launcher.isToolsServerProcessAlive(existing.pid)).toBe(true);
    }
  );

  it(
    "reuses a healthy server from the SAME bundle without respawning",
    { timeout: 30_000 },
    async () => {
      const existing = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
        token: "same-token",
      });
      spawnedPids.push(existing.pid);
      await launcher.writeToolsServerState({
        port: existing.port,
        pid: existing.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        host: "127.0.0.1",
        token: "same-token",
        managed: "autospawn",
      });

      const handle = await launcher.ensureToolsServer(fakePaths());

      // Same server reused — no new pid, same URL.
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", existing.port));
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state!.pid).toBe(existing.pid);
    }
  );

  it(
    "respawns when the SAME bundle is tracked under a different version (in-place devDep bump self-heals, no postinstall needed)",
    { timeout: 30_000 },
    async () => {
      // A healthy server recorded under an older version — the shape after
      // `argent update` rewrites tool-server.cjs in place. The next call must
      // retire it and spawn the new version, without the postinstall kill.
      const old = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
        token: "old-token",
      });
      spawnedPids.push(old.pid);
      await launcher.writeToolsServerState({
        port: old.port,
        pid: old.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        version: "1.0.0",
        host: "127.0.0.1",
        token: "old-token",
        managed: "autospawn",
      });

      const handle = await launcher.ensureToolsServer({ ...fakePaths(), version: "2.0.0" });

      // Old-version server retired; a fresh one tracked under the new version.
      await waitForDeath(old.pid);
      expect(launcher.isToolsServerProcessAlive(old.pid)).toBe(false);
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(old.pid);
      expect(state!.version).toBe("2.0.0");
      spawnedPids.push(state!.pid);
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", state!.port));
    }
  );

  it(
    "reuses a NEWER same-bundle server instead of killing it (no version ping-pong across live sessions)",
    { timeout: 30_000 },
    async () => {
      // Inverse of the self-heal case: the server already runs the bumped bundle
      // (recorded 2.0.0) while THIS caller is frozen at 1.0.0 — a second
      // long-lived MCP session. It must REUSE the newer healthy server: killing
      // on any mismatch makes two sessions ping-pong SIGTERMs.
      const newer = await launcher.spawnToolsServer(fakePaths(), await launcher.findFreePort(), {
        token: "newer-token",
      });
      spawnedPids.push(newer.pid);
      await launcher.writeToolsServerState({
        port: newer.port,
        pid: newer.pid,
        startedAt: new Date().toISOString(),
        bundlePath: FAKE_BUNDLE,
        version: "2.0.0",
        host: "127.0.0.1",
        token: "newer-token",
        managed: "autospawn",
      });

      const handle = await launcher.ensureToolsServer({ ...fakePaths(), version: "1.0.0" });

      // Reused: the newer server is still alive and its record is untouched.
      expect(launcher.isToolsServerProcessAlive(newer.pid)).toBe(true);
      const state = await launcher.readToolsServerState(FAKE_BUNDLE);
      expect(state!.pid).toBe(newer.pid);
      expect(state!.version).toBe("2.0.0");
      expect(handle.url).toBe(launcher.formatToolsServerUrl("127.0.0.1", newer.port));
      expect(handle.token).toBe("newer-token");
    }
  );
});

/**
 * Regression test: `createPreviewWindowManager` must surface a LAUNCH FAILURE
 * to the optional `onLaunchFailure` sink so a parked `await_user_selection`
 * can fail fast (with the browser fallback URL) instead of stranding for the
 * full timeout. Electron is an optionalDependency, so on headless/CI hosts the
 * window simply cannot start — that must not look like an indefinite hang.
 *
 * Two launch-failure paths are covered, both hermetically (no real Electron
 * spawn):
 *   (a) the synchronous resolve of the electron binary / main script throws —
 *       the common electron-absent case;
 *   (b) `spawn` returns a child that then emits `error` (ENOENT / EACCES).
 *
 * The post-launch `send()` stdin-write failure path is intentionally NOT a
 * launch failure (the window is already up) and must NOT call onLaunchFailure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

import { createPreviewWindowManager } from "../src/utils/preview-window";

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdin: { write: (s: string) => boolean; destroyed: boolean };
  stderr: EventEmitter;
  kill: () => boolean;
  exitCode: number | null;
  killed: boolean;
  /** Parsed `{cmd,...}` messages sent over stdin. */
  sent: Array<{ cmd: string; [k: string]: unknown }>;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 4242;
  ee.sent = [];
  ee.stdin = {
    write: (s: string) => {
      // The manager writes line-delimited JSON; record the parsed command.
      for (const line of s.split("\n").filter(Boolean)) {
        try {
          ee.sent.push(JSON.parse(line));
        } catch {
          /* ignore non-JSON */
        }
      }
      return true;
    },
    destroyed: false,
  };
  ee.stderr = new EventEmitter();
  ee.kill = () => true;
  ee.exitCode = null;
  ee.killed = false;
  return ee;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("createPreviewWindowManager — onLaunchFailure", () => {
  it("(a) fires onLaunchFailure when the sync electron-binary resolve throws", () => {
    const failures: Error[] = [];
    // Force the synchronous resolve step to throw — the common electron-absent
    // case where `require("electron")` fails. A throwing getter on
    // `electronBinaryPath` is the simplest hermetic trigger of the try/catch
    // around the resolve, exactly where the optional dependency would blow up.
    const mgr = createPreviewWindowManager({
      get electronBinaryPath(): string {
        throw new Error("Cannot find module 'electron'");
      },
      mainScript: "/tmp/does-not-matter.cjs",
      onError: () => {},
      onLaunchFailure: (err) => failures.push(err),
    });

    mgr.ensureOpen("http://127.0.0.1:1234/preview/");

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toMatch(/electron/i);
    // The sync-resolve failure must NOT have reached spawn.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("(b) fires onLaunchFailure when the spawned child emits an async error", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const failures: Error[] = [];

    const mgr = createPreviewWindowManager({
      electronBinaryPath: "/fake/electron",
      mainScript: "/fake/main.cjs",
      onError: () => {},
      onLaunchFailure: (err) => failures.push(err),
    });

    mgr.ensureOpen("http://127.0.0.1:1234/preview/");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // spawn() returns synchronously but ENOENT / EACCES arrives async.
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toMatch(/ENOENT/);
  });

  it("does NOT fire onLaunchFailure for a post-launch stdin-write failure", () => {
    // First ensureOpen spawns a healthy child. A later send() whose stdin
    // write throws means the window already launched — that is a reportError
    // case, NOT a launch failure.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const failures: Error[] = [];
    const errors: Error[] = [];

    const mgr = createPreviewWindowManager({
      electronBinaryPath: "/fake/electron",
      mainScript: "/fake/main.cjs",
      onError: (e) => errors.push(e),
      onLaunchFailure: (err) => failures.push(err),
    });

    mgr.ensureOpen("http://127.0.0.1:1234/preview/"); // spawns child
    expect(failures).toHaveLength(0);

    // Make the stdin write throw, then trigger a send via requestClose().
    child.stdin.write = () => {
      throw new Error("write EPIPE");
    };
    mgr.requestClose();

    expect(errors.some((e) => /EPIPE/.test(e.message))).toBe(true);
    expect(failures).toHaveLength(0); // launch already succeeded
  });

  it("strips ELECTRON_RUN_AS_NODE from the child env so the child boots as a GUI app", () => {
    // Regression: an Electron-based MCP host (VS Code / Cursor / Codex desktop)
    // spawns the tool-server with ELECTRON_RUN_AS_NODE=1. If that leaks into the
    // preview-window child, the Electron binary boots in Node mode —
    // `require("electron")` returns the binary path string, `.app` is undefined,
    // and main.cjs crashes at `app.setName()` (the window never opens).
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const mgr = createPreviewWindowManager({
        electronBinaryPath: "/fake/electron",
        mainScript: "/fake/main.cjs",
        onError: () => {},
      });
      mgr.ensureOpen("http://127.0.0.1:1234/preview/");

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const spawnEnv = (spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      // The per-launch override still comes through.
      expect(spawnEnv.ARGENT_PREVIEW_URL).toBe("http://127.0.0.1:1234/preview/");
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it("does NOT fire onLaunchFailure when the window is already alive (re-open foregrounds)", () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const failures: Error[] = [];

    const mgr = createPreviewWindowManager({
      electronBinaryPath: "/fake/electron",
      mainScript: "/fake/main.cjs",
      onError: () => {},
      onLaunchFailure: (err) => failures.push(err),
    });

    mgr.ensureOpen("http://127.0.0.1:1234/preview/"); // spawns
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=x"); // foregrounds, no respawn

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(0);
  });
});

/**
 * Regression for the close-animation race (PR #271 FIX 4): if a new round parks
 * (ensureOpen) while the window is mid-close — `requestClose()` sent `close` but
 * the child hasn't exited yet — the manager must spawn a FRESH window instead of
 * foregrounding the about-to-quit child (which would leave the new round
 * windowless until its timeout). Normal reuse and close must keep working.
 */
describe("createPreviewWindowManager — close-animation race", () => {
  function newMgr() {
    return createPreviewWindowManager({
      electronBinaryPath: "/fake/electron",
      mainScript: "/fake/main.cjs",
      onError: () => {},
    });
  }

  it("ensureOpen during a pending close RESPAWNS rather than reusing the doomed child", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const mgr = newMgr();

    mgr.ensureOpen("http://127.0.0.1:1234/preview/"); // spawns `first`
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Close is requested; `first` is still alive (animating), exitCode null.
    mgr.requestClose();
    expect(first.sent.map((m) => m.cmd)).toContain("close");

    // A fresh round parks BEFORE `first` exited. Must spawn `second`, not
    // foreground the doomed `first`.
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=x");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // `first` was never told to foreground after the close — it stays doomed.
    expect(first.sent.filter((m) => m.cmd === "foreground")).toHaveLength(0);
    // `second` is the live window for the new round.
    expect(second.sent.filter((m) => m.cmd === "foreground")).toHaveLength(0); // freshly spawned, no foreground msg needed
  });

  it("the doomed child exiting after a respawn does NOT clobber the new live child", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const mgr = newMgr();

    mgr.ensureOpen("http://127.0.0.1:1234/preview/");
    mgr.requestClose();
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=x"); // spawns `second`

    // The old (closing) child finally exits. `second` is now current, so this
    // late exit must not null it out.
    first.exitCode = 0;
    first.emit("exit");

    // A subsequent ensureOpen should REUSE `second` (foreground), not respawn —
    // proving `second` is still the live handle and not `closing`.
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=y");
    expect(spawnMock).toHaveBeenCalledTimes(2); // no third spawn
    expect(second.sent.filter((m) => m.cmd === "foreground")).toHaveLength(1);
  });

  it("normal reuse (no close in between) still foregrounds, never respawns", () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const mgr = newMgr();

    mgr.ensureOpen("http://127.0.0.1:1234/preview/");
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=x");
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=y");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.sent.filter((m) => m.cmd === "foreground")).toHaveLength(2);
  });

  it("after the (only) child exits, a fresh round spawns a NEW window (closing flag reset)", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const mgr = newMgr();

    mgr.ensureOpen("http://127.0.0.1:1234/preview/");
    mgr.requestClose();
    // The window actually exits (close animation finished).
    first.exitCode = 0;
    first.emit("exit");

    // Next round: the manager must spawn fresh (child was reset, not stuck in
    // a `closing` state that would mis-trigger anything).
    mgr.ensureOpen("http://127.0.0.1:1234/preview/?udid=x");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("requestClose is a no-op when no window is alive", () => {
    const mgr = newMgr();
    // Never opened — must not throw and must not spawn.
    expect(() => mgr.requestClose()).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

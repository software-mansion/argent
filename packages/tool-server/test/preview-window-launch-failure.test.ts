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
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 4242;
  ee.stdin = { write: () => true, destroyed: false };
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

/**
 * `resolveHostFingerprint` shells out to `simulator-server fingerprint`. It must
 * be best-effort: any failure (binary missing, non-zero exit, timeout, empty
 * output) returns null so identity falls back to a random id and never throws.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const execFileSyncMock = vi.fn();
// spawn(binary, args, opts) -> the async form used by the non-blocking resolver.
// The mock returns a fake ChildProcess a test can drive by emitting
// stdout 'data' / 'close' / 'error'.
const spawnMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const binaryPathMock = vi.fn(() => "/fake/simulator-server");
vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => binaryPathMock(),
}));

import { resolveHostFingerprint, resolveHostFingerprintAsync } from "../src/fingerprint.js";

// A fake ChildProcess with the members the resolver touches: a stdout emitter
// (setEncoding / on('data') / unref) and the process-level on/unref/kill.
interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}
function makeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    unref: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    unref: vi.fn(),
    kill: vi.fn(),
  }) as FakeChild;
  return child;
}

describe("resolveHostFingerprint", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
    binaryPathMock.mockReset();
    binaryPathMock.mockReturnValue("/fake/simulator-server");
  });

  it("returns the trimmed fingerprint on success", () => {
    execFileSyncMock.mockReturnValue(`${"a".repeat(64)}\n`);
    expect(resolveHostFingerprint()).toBe("a".repeat(64));
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/fake/simulator-server",
      ["fingerprint"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("hard-bounds the spawn: SIGKILL kill signal, capped stdout, and the timeout", () => {
    // The sync path blocks the event loop, so a JS-side watchdog can't run — the
    // bound must come from spawnSync itself. killSignal SIGKILL (untrappable)
    // guarantees a SIGTERM-ignoring binary is reaped at the cap instead of
    // freezing the command; maxBuffer caps captured stdout.
    execFileSyncMock.mockReturnValue(`${"a".repeat(64)}\n`);
    resolveHostFingerprint();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/fake/simulator-server",
      ["fingerprint"],
      expect.objectContaining({ killSignal: "SIGKILL", maxBuffer: 4096, timeout: 5_000 })
    );
  });

  it("returns null for empty / whitespace-only output", () => {
    execFileSyncMock.mockReturnValue("   \n");
    expect(resolveHostFingerprint()).toBeNull();
  });

  it("returns null when the command throws (missing binary / non-zero exit / timeout)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    expect(resolveHostFingerprint()).toBeNull();
  });

  it("returns null when the binary path cannot be resolved", () => {
    binaryPathMock.mockImplementation(() => {
      throw new Error("simulator-server binary not found for platform");
    });
    expect(resolveHostFingerprint()).toBeNull();
  });
});

describe("resolveHostFingerprintAsync", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    binaryPathMock.mockReset();
    binaryPathMock.mockReturnValue("/fake/simulator-server");
  });

  it("resolves the trimmed fingerprint on a clean exit", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", `${"a".repeat(64)}\n`);
    child.emit("close", 0);
    await expect(p).resolves.toBe("a".repeat(64));
    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/simulator-server",
      ["fingerprint"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] })
    );
  });

  it("resolves null for empty / whitespace-only output", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", "  \n");
    child.emit("close", 0);
    await expect(p).resolves.toBeNull();
  });

  it("resolves null on a non-zero exit code", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", "a".repeat(64));
    child.emit("close", 1);
    await expect(p).resolves.toBeNull();
  });

  it("resolves null (never rejects) when the child errors (missing binary / spawn error)", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.emit("error", new Error("spawn ENOENT"));
    await expect(p).resolves.toBeNull();
  });

  it("resolves null (never rejects) when the binary path cannot be resolved", async () => {
    binaryPathMock.mockImplementation(() => {
      throw new Error("simulator-server binary not found for platform");
    });
    await expect(resolveHostFingerprintAsync()).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("resolves null when spawn throws synchronously", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("bad options");
    });
    await expect(resolveHostFingerprintAsync()).resolves.toBeNull();
  });

  it("unrefs the child AND its stdout pipe so a background probe never keeps the process alive", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", "b".repeat(64));
    child.emit("close", 0);
    await p;
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.stdout.unref).toHaveBeenCalledTimes(1);
  });

  it("is settle-once: a late error after a clean close is fully ignored (no second reap)", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", "c".repeat(64));
    child.emit("close", 0); // finish() #1 -> resolves + one reap
    child.emit("error", new Error("late")); // must be dropped by the `settled` guard
    await expect(p).resolves.toBe("c".repeat(64));
    // The `settled` guard prevents the late error from re-entering finish(): the
    // child is reaped exactly once (deleting the guard makes this 2).
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("caps runaway output: SIGKILLs the child and resolves null past the buffer limit", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const p = resolveHostFingerprintAsync();
    child.stdout.emit("data", "a".repeat(5000)); // > 4 KiB cap
    await expect(p).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  describe("watchdog (bounded settlement)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("SIGKILLs a wedged child and resolves null at the timeout — the promise ALWAYS settles", async () => {
      const child = makeChild();
      spawnMock.mockReturnValue(child);
      const p = resolveHostFingerprintAsync();
      // Child never emits 'close' (ignores the spawn timeout's SIGTERM).
      await vi.advanceTimersByTimeAsync(5001);
      await expect(p).resolves.toBeNull();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });
});

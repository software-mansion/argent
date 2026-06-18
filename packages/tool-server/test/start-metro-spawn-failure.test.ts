import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { startMetroTool } from "../src/tools/simulator/start-metro";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * A fake child that reproduces a real spawn failure (ENOENT): `pid` is
 * undefined and the `error` event fires *asynchronously* on a later tick —
 * exactly what node:child_process does when the executable isn't found. Backed
 * by a real EventEmitter, so an unhandled `error` throws the same way it crashes
 * the tool-server in production. The other start-metro tests mock the child as a
 * plain object, so the deferred `error` never fires and this crash path is
 * invisible to them.
 */
function spawnFailureChild(err: NodeJS.ErrnoException) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: () => void;
  };
  child.pid = undefined;
  child.unref = () => {};
  // Defer to a later tick, like node:child_process does for ENOENT.
  setImmediate(() => child.emit("error", err));
  return child;
}

describe("start-metro spawn failure", () => {
  it("rejects with the spawn error and never lets the deferred 'error' crash the process", async () => {
    // Port looks free: /status probe fails, no listeners on the port.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn missing-cmd ENOENT"), {
      code: "ENOENT",
    });
    (spawn as Mock).mockReturnValue(spawnFailureChild(enoent));

    // If the only 'error' listener were removed before the deferred event fires
    // (the bug), the unhandled 'error' would surface as an uncaughtException —
    // which the tool-server turns into a full crashShutdown. Capture any such
    // exception so the test fails loudly instead of the process going down.
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);

    try {
      await expect(
        startMetroTool.execute!(
          {},
          { port: 8137, reuseExisting: true, command: "missing-cmd", args: [] }
        )
      ).rejects.toThrow(/ENOENT/);

      // Let any straggling deferred 'error' fire after the call has settled.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
  });
});

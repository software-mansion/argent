import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-server-logs-"));
  fs.mkdirSync(path.join(home, ".argent"));
  fs.writeFileSync(path.join(home, ".argent", "tool-server.log"), "listening\n");
  fs.mkdirSync(path.join(home, "empty-bin"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PATH", path.join(home, "empty-bin"));
  // server.ts resolves the log path from the home directory at import time.
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function captureExit(): Promise<{ code?: number; printed: string[] }> {
  const err: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void err.push(args.join(" ")));
  // Snapshot at exit: the real process.exit drops anything printed after it.
  return new Promise((resolve) => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) =>
      resolve({ code, printed: [...err] })) as never);
  });
}

describe("argent server logs --follow", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "passes %s on to tail, then exits with tail's status",
    async (signal) => {
      const { EventEmitter } = await import("node:events");
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      vi.doMock("node:child_process", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:child_process")>()),
        spawn: () => child,
      }));
      const before = new Set(process.listeners(signal));
      const exited = captureExit();
      const { server } = await import("../src/server.js");

      try {
        await server(["logs", "-f"]);
        const added = process.listeners(signal).filter((listener) => !before.has(listener));
        expect(added).toHaveLength(1);
        (added[0] as () => void)();
        expect(child.kill).toHaveBeenCalledWith(signal);
        child.emit("exit", null, signal);
        expect((await exited).code).toBe(128 + os.constants.signals[signal]);
      } finally {
        for (const listener of process.listeners(signal)) {
          if (!before.has(listener)) process.removeListener(signal, listener);
        }
      }
    }
  );

  it("reports a `tail` that cannot be spawned and exits 1", async () => {
    const exited = captureExit();
    const { server } = await import("../src/server.js");

    await server(["logs", "-f"]);

    expect(await exited).toEqual({
      code: 1,
      printed: [
        "argent server logs: cannot run `tail` to follow the log (spawn tail ENOENT). " +
          "Run `argent server logs` without -f to print it.",
      ],
    });
  });

  it("reports a spawn error that spawn() throws instead of emitting", async () => {
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      spawn: () => {
        throw new Error("spawn ENOEXEC");
      },
    }));
    const exited = captureExit();
    const { server } = await import("../src/server.js");

    await server(["logs", "-f"]);

    expect(await exited).toEqual({
      code: 1,
      printed: [
        "argent server logs: cannot run `tail` to follow the log (spawn ENOEXEC). " +
          "Run `argent server logs` without -f to print it.",
      ],
    });
  });
});

import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The log path is resolved from the home directory at import time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-logs-unreadable-"));
const realHome = process.env.HOME;
process.env.HOME = home;
const logPath = path.join(home, ".argent", "tool-server.log");
// A directory at the log path fails the read with EISDIR, even when run as root.
fs.mkdirSync(logPath, { recursive: true });
const { server } = await import("../src/server.js");
process.env.HOME = realHome;

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe("argent server logs with an unreadable log", () => {
  it("prints one line naming the error and exits 1", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(server(["logs"])).rejects.toBeInstanceOf(ExitCalled);

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe(
      `argent server logs: cannot read ${logPath} (EISDIR: illegal operation on a directory, read).`
    );
    expect(write).not.toHaveBeenCalled();
  });
});

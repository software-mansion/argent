import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `argent server logs -f` hands the follow to `tail` and mirrors its exit. A
 * `tail` killed by a signal must surface as 128+signo (like `server start`
 * does), not as a clean exit 0.
 */

const spawn = vi.fn();

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

// The log path is resolved from the home directory at import time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-logs-exit-"));
const realHome = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".argent"));
fs.writeFileSync(path.join(home, ".argent", "tool-server.log"), "LOG-LINE\n");
const { server } = await import("../src/server.js");
process.env.HOME = realHome;

afterEach(() => {
  vi.restoreAllMocks();
  spawn.mockReset();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function exitCodeWhenTailExits(
  code: number | null,
  signal: NodeJS.Signals | null
): Promise<number | undefined> {
  const child = new EventEmitter();
  spawn.mockReturnValue(child);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await server(["logs", "-f"]);
  expect(spawn).toHaveBeenCalledWith("tail", ["-f", expect.any(String)], expect.anything());
  child.emit("exit", code, signal);
  expect(exit).toHaveBeenCalledTimes(1);
  return exit.mock.calls[0]![0] as number | undefined;
}

describe("argent server logs -f exit code", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGKILL", 137],
    ["SIGPIPE", 141],
    ["SIGQUIT", 131],
  ] as const)("exits 128+signo when tail is killed by %s", async (signal, expected) => {
    expect(await exitCodeWhenTailExits(null, signal)).toBe(expected);
  });

  it.each([0, 1, 3])("passes tail's own exit code %i through", async (code) => {
    expect(await exitCodeWhenTailExits(code, null)).toBe(code);
  });
});

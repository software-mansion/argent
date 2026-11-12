import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const spawn = vi.fn();

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

// Server state paths are resolved from the home directory at import time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-start-spawn-"));
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
let server: typeof import("../src/server.js").server;
beforeAll(async () => {
  vi.stubEnv("HOME", home);
  try {
    ({ server } = await import("../src/server.js"));
  } finally {
    vi.unstubAllEnvs();
  }
});

const paths = {
  bundlePath: path.join(home, "tool-server.cjs"),
  simulatorServerDir: path.join(home, "bin"),
  nativeDevtoolsDir: path.join(home, "dylibs"),
};

afterEach(() => {
  vi.restoreAllMocks();
  spawn.mockReset();
});

describe("argent server start spawn failure", () => {
  it("reports a synchronous spawn error without registering signals or writing state", async () => {
    const error = Object.assign(new Error("spawn ELOOP"), {
      code: "ELOOP",
      syscall: "spawn",
      errno: -40,
    });
    spawn.mockImplementation(() => {
      throw error;
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const on = vi.spyOn(process, "on");
    const onInt = process.listeners("SIGINT");
    const onTerm = process.listeners("SIGTERM");

    await expect(
      server(["start", "--no-auth", "--port", "39871"], { paths })
    ).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledExactlyOnceWith("node", [paths.bundlePath, "start"], {
      stdio: "inherit",
      env: expect.objectContaining({ ARGENT_PORT: "39871" }),
    });
    expect(stderr.mock.calls).toEqual([
      ["argent server start: failed to spawn tool-server: spawn ELOOP"],
    ]);
    expect(stdout).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(on.mock.calls.filter(([signal]) => signal === "SIGINT" || signal === "SIGTERM")).toEqual(
      []
    );
    expect(process.listeners("SIGINT")).toEqual(onInt);
    expect(process.listeners("SIGTERM")).toEqual(onTerm);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

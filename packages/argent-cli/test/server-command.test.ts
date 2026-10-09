import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `argent server status|stop|logs` through the real entry point, with the
// tool-server state and the kill stubbed so "did it act" is observable.

const client = vi.hoisted(() => ({
  readToolsServerState: vi.fn(),
  readAllToolsServerStates: vi.fn(async () => []),
  killToolServer: vi.fn(async () => true),
  isToolsServerProcessAlive: vi.fn(() => true),
  isToolsServerHealthy: vi.fn(async () => true),
}));

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  ...client,
}));

// The log path comes from homedir() at module load, so HOME is redirected
// before the import.
let server: typeof import("../src/server.js").server;
let home: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-cmd-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  ({ server } = await import("../src/server.js"));
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  client.readToolsServerState.mockResolvedValue({
    port: 3001,
    pid: 4242,
    startedAt: "2026-01-01T00:00:00.000Z",
    bundlePath: "/bundle/tool-server.cjs",
    host: "127.0.0.1",
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const output = () => (logSpy.mock.calls as unknown[][]).map((c) => c.join(" ")).join("\n");
const errors = () => (errSpy.mock.calls as unknown[][]).map((c) => c.join(" ")).join("\n");

function expectNoAction(): void {
  expect(client.killToolServer).not.toHaveBeenCalled();
  expect(client.readToolsServerState).not.toHaveBeenCalled();
  expect(output()).not.toContain("No log file at");
}

describe("argent server status / stop / logs", () => {
  it.each([
    [["stop", "--help"], "Usage: argent server stop"],
    [["stop", "-h"], "Usage: argent server stop"],
    [["stop", "--anything", "--help"], "Usage: argent server stop"],
    [["status", "--help"], "Usage: argent server status [--json]"],
    [["status", "--json", "-h"], "Usage: argent server status [--json]"],
    [["logs", "--help"], "Usage: argent server logs [-f]"],
    [["logs", "-f", "--help"], "Usage: argent server logs [-f]"],
  ])("prints the help for %j without acting", async (argv, usage) => {
    await server(argv);

    expect(output()).toContain(usage);
    expect(output()).toContain("--help, -h");
    expectNoAction();
  });

  it.each([
    [["stop", "--anything"], "Unknown flag: --anything"],
    [["stop", "now"], 'Unexpected argument "now"'],
    [["status", "--bogus"], "Unknown flag: --bogus"],
    [["status", "-f"], "Unknown flag: -f"],
    [["logs", "--json"], "Unknown flag: --json"],
  ])("rejects %j with exit 2 without acting", async (argv, message) => {
    await expect(server(argv)).rejects.toThrow("process.exit:2");

    expect(errors()).toContain(`Error: ${message}`);
    expectNoAction();
  });

  it("stops the tool-server", async () => {
    await server(["stop"]);

    expect(client.killToolServer).toHaveBeenCalledTimes(1);
    expect(output()).toContain("tool-server stopped (pid 4242).");
  });

  it("reports the status as JSON", async () => {
    await server(["status", "--json"]);

    expect(JSON.parse(output())).toMatchObject({ running: true, pid: 4242, port: 3001 });
  });

  it("reads the log", async () => {
    await server(["logs"]);

    expect(output()).toBe(`No log file at ${path.join(home, ".argent", "tool-server.log")}`);
  });
});

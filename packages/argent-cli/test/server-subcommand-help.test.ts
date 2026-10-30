import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `--help` on a subcommand that acts on a live server must print usage and
 * stop there: `stop --help` used to kill the server and `logs --help` used to
 * dump the whole log.
 */

const killToolServer = vi.fn();
const readToolsServerState = vi.fn();
const spawn = vi.fn();

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  killToolServer,
  readToolsServerState,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

// The log path is resolved from the home directory at import time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-help-"));
const realHome = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".argent"));
fs.writeFileSync(path.join(home, ".argent", "tool-server.log"), "LOG-LINE-MARKER\n");
const { server } = await import("../src/server.js");
process.env.HOME = realHome;

const paths = { bundlePath: "/nonexistent/tool-server.cjs" } as never;

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  killToolServer.mockReset();
  readToolsServerState.mockReset();
  spawn.mockReset();
});

describe("argent server <sub> --help", () => {
  it.each([
    "stop --help",
    "stop -h",
    "status --help",
    "status --json -h",
    "logs --help",
    "logs -f --help",
  ])("server %s prints usage without touching the server", async (args) => {
    const argv = args.split(" ");
    await server(argv, { paths });
    const printed = out.join("\n");
    expect(printed).toContain("argent server stop");
    expect(printed).not.toContain("LOG-LINE-MARKER");
    expect(killToolServer).not.toHaveBeenCalled();
    expect(readToolsServerState).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

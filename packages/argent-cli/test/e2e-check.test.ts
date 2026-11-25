import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolInvocationError } from "@argent/tools-client";
import { e2e } from "../src/e2e.js";

const toolsClientMock = vi.hoisted(() => ({ fetchTool: vi.fn(), callTool: vi.fn() }));

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  createToolsClient: vi.fn(() => toolsClientMock),
  getResolvedToolsUrl: vi.fn(async () => ({ url: "http://127.0.0.1:47899", source: "env" })),
}));

const CHECK_TOOL = { name: "e2e-check", description: "", inputSchema: {} };

describe("argent e2e check", () => {
  let root: string;
  let previousCwd: string;
  let logs: string[];
  let errs: string[];
  const opts = { paths: {} as never };

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-check-")));
    await fsp.writeFile(path.join(root, "good.yaml"), "steps:\n  - echo: fine\n");
    await fsp.writeFile(path.join(root, "bad.yaml"), "steps:\n  - echo: fine\n");
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    toolsClientMock.fetchTool.mockResolvedValue(CHECK_TOOL);
    toolsClientMock.callTool.mockImplementation(async (_tool, args: { e2e_test_path: string }) => ({
      data: {
        problems:
          path.basename(args.e2e_test_path) === "bad.yaml"
            ? [
                { message: 'Tool "gesture-swpie" not found' },
                { code: "FLOW_FILE_INVALID", message: "retired key" },
              ]
            : [],
      },
    }));
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    previousCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
  });

  it("asks the tool-server to check the test and exits 0 when it finds no problem", async () => {
    await expect(e2e(["check", "good.yaml", "--json"], opts)).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith("e2e-check", {
      e2e_test_path: path.join(root, "good.yaml"),
      project_root: root,
    });
    expect(JSON.parse(logs.join("\n"))).toEqual({
      ok: true,
      e2eTests: [{ path: "good.yaml", ok: true, problems: [] }],
    });
    expect(errs).toEqual([]);
  });

  it("exits 1 and prints each problem under the path of its test", async () => {
    await expect(e2e(["check", "bad.yaml"], opts)).rejects.toThrow("process.exit:1");

    expect(errs).toEqual(['bad.yaml: Tool "gesture-swpie" not found', "bad.yaml: retired key"]);
    expect(logs).toEqual(["2 errors in 1 of 1 e2e test"]);
  });

  it("reports a refusal of the test as its problem, with its code", async () => {
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError('[Tool:e2e-check] Invalid e2e test path "Good.yaml"', {
        errorCode: "FLOW_FILE_INVALID",
        errorKind: "validation",
      })
    );

    await expect(e2e(["check", "good.yaml", "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(JSON.parse(logs.join("\n")).e2eTests[0].problems).toEqual([
      {
        file: "good.yaml",
        code: "FLOW_FILE_INVALID",
        message: 'Invalid e2e test path "Good.yaml"',
      },
    ]);
  });

  it("exits 2 for a missing file without asking the tool-server", async () => {
    await expect(e2e(["check", "missing.yaml"], opts)).rejects.toThrow("process.exit:2");

    expect(errs).toEqual([`E2E test file not found: ${path.join(root, "missing.yaml")}`]);
    expect(toolsClientMock.fetchTool).not.toHaveBeenCalled();
  });

  it("exits 2 when the routed tool-server refuses the connection", async () => {
    toolsClientMock.fetchTool.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:47899"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      })
    );

    await expect(e2e(["check", "good.yaml"], opts)).rejects.toThrow("process.exit:2");

    expect(errs).toEqual([
      "Could not reach the tool-server at http://127.0.0.1:47899 (set by ARGENT_TOOLS_URL): " +
        "connection refused.\nStart that tool-server, or unset ARGENT_TOOLS_URL to use the local one.",
    ]);
    expect(logs).toEqual([]);
  });

  it("exits 2 for a tool-server without the e2e-check tool", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(null);

    await expect(e2e(["check", "good.yaml"], opts)).rejects.toThrow("process.exit:2");

    expect(errs).toEqual([expect.stringContaining("has no e2e-check tool")]);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 when the check fails for a reason other than the test", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("[Tool:e2e-check] disk full"));

    await expect(e2e(["check", "good.yaml"], opts)).rejects.toThrow("process.exit:2");

    expect(errs).toEqual(["[Tool:e2e-check] disk full"]);
  });
});

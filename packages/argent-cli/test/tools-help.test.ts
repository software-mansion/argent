import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tools } from "../src/tools.js";

// `argent tools --help` used to print the whole tool catalogue — and to contact
// the tool-server (starting one) to get it — because the help flag was filtered
// out before the subcommand was read. These drive the real entry point with a
// mocked client so "did it reach the server" is observable.

const toolsClientMock = vi.hoisted(() => ({
  fetchTool: vi.fn(),
  fetchTools: vi.fn(),
}));

vi.mock("@argent/tools-client", () => ({
  createToolsClient: vi.fn(() => toolsClientMock),
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  toolsClientMock.fetchTools.mockResolvedValue([
    { name: "gesture-tap", description: "Tap the screen" },
  ]);
  toolsClientMock.fetchTool.mockResolvedValue({
    name: "gesture-tap",
    description: "Tap the screen",
    inputSchema: { type: "object", properties: { udid: { type: "string" } }, required: ["udid"] },
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const output = () => (logSpy.mock.calls as unknown[][]).map((c) => String(c[0] ?? "")).join("\n");

const invoke = (argv: string[]) => tools(argv, { paths: {} as never });

describe("argent tools --help", () => {
  it.each([["--help"], ["-h"], ["--help", "--json"], ["--json", "--help"]])(
    "prints usage for %j without contacting the tool-server",
    async (...argv) => {
      await invoke(argv);

      expect(output()).toContain("argent tools describe <name>");
      expect(output()).toContain("--help, -h");
      // The defect: help used to start a tool-server just to list tools.
      expect(toolsClientMock.fetchTools).not.toHaveBeenCalled();
      expect(toolsClientMock.fetchTool).not.toHaveBeenCalled();
    }
  );

  it("still lists tools when no subcommand is given", async () => {
    await invoke([]);
    expect(toolsClientMock.fetchTools).toHaveBeenCalled();
  });

  it("still describes a named tool", async () => {
    await invoke(["describe", "gesture-tap"]);
    expect(toolsClientMock.fetchTool).toHaveBeenCalledWith("gesture-tap");
  });

  it("leaves a trailing --help for the tool being described", async () => {
    // `argent tools describe <name> --help` asks for that tool's flags, not for
    // this command's usage.
    await invoke(["describe", "gesture-tap", "--help"]);

    expect(toolsClientMock.fetchTool).toHaveBeenCalledWith("gesture-tap");
    expect(output()).not.toContain("argent tools describe <name>");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

const toolsClientMock = vi.hoisted(() => ({
  fetchTool: vi.fn(),
  callTool: vi.fn(),
}));

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  track: vi.fn(),
}));

vi.mock("@argent/tools-client", () => ({
  createToolsClient: vi.fn(() => toolsClientMock),
}));

vi.mock("@argent/telemetry", () => telemetryMock);

const toolMeta = {
  name: "sample-tool",
  description: "Sample tool",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

describe("argent run telemetry", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolsClientMock.fetchTool.mockResolvedValue(toolMeta);
    toolsClientMock.callTool.mockResolvedValue({ data: { ok: true } });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("emits cli:run_fail, not tool:fail, when tool-server call fails", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("server already tracked this"));

    await expect(run(["sample-tool"], { paths: {} as never })).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith("server already tracked this");
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "cli:run_fail",
      expect.objectContaining({
        tool: "sample-tool",
        error_code: "CLI_RUN_TOOL_CALL_FAILED",
        failure_stage: "cli_run_call_tool",
        failure_area: "cli",
        error_kind: "unknown",
      })
    );
    expect(telemetryMock.track).not.toHaveBeenCalledWith("tool:fail", expect.anything());
    expect(telemetryMock.shutdown).toHaveBeenCalledTimes(1);
  });

  it("emits cli:run_fail, not tool:fail, for local CLI argument parsing failures", async () => {
    await expect(
      run(["sample-tool", "--args", "not-json"], { paths: {} as never })
    ).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "cli:run_fail",
      expect.objectContaining({
        tool: "sample-tool",
        error_code: "CLI_RUN_ARGS_JSON_INVALID",
        failure_stage: "cli_run_parse_raw_args",
        failure_area: "cli",
        error_kind: "validation",
      })
    );
    expect(telemetryMock.track).not.toHaveBeenCalledWith("tool:fail", expect.anything());
    expect(telemetryMock.shutdown).toHaveBeenCalledTimes(1);
  });
});

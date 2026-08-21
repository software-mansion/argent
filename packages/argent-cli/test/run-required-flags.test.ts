import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolInvocationError } from "@argent/tools-client";
import { run } from "../src/run.js";

const toolsClientMock = vi.hoisted(() => ({
  fetchTool: vi.fn(),
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:3001", token: "t" })),
}));

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  track: vi.fn(),
}));

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createToolsClient: vi.fn(() => toolsClientMock),
    materializeArtifacts: vi.fn(async (result: unknown) => ({ result, images: [] })),
  };
});

vi.mock("@argent/telemetry", () => telemetryMock);

const gestureTap = {
  name: "gesture-tap",
  description: "Tap the screen",
  inputSchema: {
    type: "object",
    properties: {
      udid: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      clickCount: { type: "integer" },
    },
    required: ["udid", "x", "y"],
  },
};

const runSequence = {
  name: "run-sequence",
  description: "Run steps",
  inputSchema: {
    type: "object",
    properties: {
      udid: { type: "string" },
      steps: { type: "array", items: { type: "object" } },
    },
    required: ["udid", "steps"],
  },
};

const invoke = (argv: string[]) => run(argv, { paths: {} as never });

function stderr(): string {
  return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .join("\n");
}

function stdout(): string {
  return (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .join("\n");
}

describe("argent run input validation", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    toolsClientMock.callTool.mockResolvedValue({ data: { tapped: true } });
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

  it("names the missing flags and shows the tool's help without calling the tool", async () => {
    await expect(invoke(["gesture-tap"])).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(stderr()).toContain("Error: missing required flags --udid, --x, --y");
    expect(stdout()).toContain("argent run gesture-tap [flags]");
    expect(stdout()).toContain("--udid <value>");
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "cli:run_fail",
      expect.objectContaining({
        tool: "gesture-tap",
        error_code: "CLI_RUN_INPUT_VALIDATION_FAILED",
        failure_stage: "cli_run_required_flags",
        failure_area: "cli",
        error_kind: "validation",
      })
    );
  });

  it("never prints a raw issue list", async () => {
    await expect(invoke(["gesture-tap"])).rejects.toThrow("process.exit:2");
    expect(stderr()).not.toContain("invalid_type");
    expect(stderr()).not.toContain('"path"');
  });

  it("accepts required fields supplied through --args", async () => {
    await invoke(["gesture-tap", "--args", '{"udid":"X","x":0.5,"y":0.5}']);

    expect(toolsClientMock.callTool).toHaveBeenCalledWith("gesture-tap", {
      udid: "X",
      x: 0.5,
      y: 0.5,
    });
  });

  it("accepts required fields split across --args and flags", async () => {
    await invoke(["gesture-tap", "--udid", "X", "--args", '{"x":0.5,"y":0.5}']);
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
  });

  it("reports only the fields still missing after --args is merged", async () => {
    await expect(invoke(["gesture-tap", "--args", '{"x":0.5}'])).rejects.toThrow("process.exit:2");
    expect(stderr()).toContain("missing required flags --udid, --y");
  });

  it("names a JSON-only field by its -json flag", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(runSequence);

    await expect(invoke(["run-sequence", "--udid", "X"])).rejects.toThrow("process.exit:2");
    expect(stderr()).toContain("Error: missing required flag --steps-json");
  });

  it("accepts a JSON-only field passed as --field-json", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(runSequence);

    await invoke(["run-sequence", "--udid", "X", "--steps-json", '[{"tool":"button"}]']);
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
  });

  it("still prints help for --help without demanding flags", async () => {
    await invoke(["gesture-tap", "--help"]);

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(stdout()).toContain("argent run gesture-tap [flags]");
    expect(stderr()).not.toContain("missing required");
  });

  // Built the way a live tool-server answers: prose in the message, the issue
  // list beside it. A fixture that stringifies the issues into the message
  // instead tests a wire no server sends any more.
  describe.each([
    [
      "a modern server (prose message + issues)",
      () =>
        new ToolInvocationError("`x`: Too big: expected <=1. You sent: `udid`, `x`, `y`.", {
          errorCode: "HTTP_ZOD_VALIDATION_FAILED",
          errorKind: "validation",
          issues: [{ code: "too_big", path: ["x"], message: "Too big: expected <=1" }],
        }),
    ],
    [
      "a pre-prose server (the issue list WAS the message)",
      () =>
        new Error(
          JSON.stringify([{ code: "too_big", path: ["x"], message: "Too big: expected <=1" }])
        ),
    ],
  ])("a value the tool rejects, reported by %s", (_label, buildError) => {
    beforeEach(() => {
      toolsClientMock.callTool.mockRejectedValue(buildError());
    });

    it("is reported against its flag instead of as a raw issue list", async () => {
      await expect(
        invoke(["gesture-tap", "--udid", "X", "--x", "99", "--y", "0.5"])
      ).rejects.toThrow("process.exit:2");

      expect(stderr()).toContain("Error: --x Too big: expected <=1");
      expect(stderr()).not.toContain('"code"');
      expect(stdout()).toContain("argent run gesture-tap [flags]");
      expect(telemetryMock.track).toHaveBeenCalledWith(
        "cli:run_fail",
        expect.objectContaining({
          error_code: "CLI_RUN_INPUT_VALIDATION_FAILED",
          failure_stage: "cli_run_server_validation",
          error_kind: "validation",
        })
      );
    });
  });

  it("leaves an ordinary runtime failure exactly as it was", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("Simulator not booted"));

    await expect(
      invoke(["gesture-tap", "--udid", "X", "--x", "0.5", "--y", "0.5"])
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith("Simulator not booted");
    expect(stderr()).not.toContain("Error: ");
    expect(stdout()).not.toContain("argent run gesture-tap [flags]");
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "cli:run_fail",
      expect.objectContaining({ error_code: "CLI_RUN_TOOL_CALL_FAILED", error_kind: "unknown" })
    );
  });

  describe("--json", () => {
    it("emits one machine-readable object on stderr and nothing on stdout", async () => {
      await expect(invoke(["gesture-tap", "--json"])).rejects.toThrow("process.exit:2");

      expect(stdout()).toBe("");
      const envelope = JSON.parse(stderr());
      expect(envelope).toEqual({
        error: "missing required flags --udid, --x, --y",
        missing: ["--udid", "--x", "--y"],
        issues: [],
      });
    });

    it("carries the tool's own issue list when the tool rejected a value", async () => {
      const issues = [{ code: "too_big", path: ["x"], message: "Too big: expected <=1" }];
      // The live wire: the envelope a script parses must survive the server
      // answering with prose, which is all `error` carries now.
      toolsClientMock.callTool.mockRejectedValue(
        new ToolInvocationError("`x`: Too big: expected <=1. You sent: `udid`, `x`, `y`.", {
          errorKind: "validation",
          issues,
        })
      );

      await expect(
        invoke(["gesture-tap", "--json", "--udid", "X", "--x", "99", "--y", "0.5"])
      ).rejects.toThrow("process.exit:2");

      const envelope = JSON.parse(stderr());
      expect(envelope.issues).toEqual(issues);
      expect(envelope.missing).toEqual([]);
      expect(envelope.error).toBe("--x Too big: expected <=1");
      expect(stdout()).toBe("");
    });
  });

  it("reports a missing value for a global option instead of a raw stack", async () => {
    await expect(invoke(["gesture-tap", "--out"])).rejects.toThrow("process.exit:2");

    expect(stderr()).toContain("Error: --out requires a path");
    expect(stderr()).toContain("argent run gesture-tap --help");
  });
});

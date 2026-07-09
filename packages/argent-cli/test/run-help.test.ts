import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

// Drive `printToolHelp` through the real `run(..., "--help")` entry point with a
// mocked tools-client, capturing console.log. This locks in the user-visible
// half of the fix: a tool that declares its own `args` field must NOT advertise
// the whole-payload `--args <json>` / `--args -` escape hatch (it no longer
// applies), while a tool without one keeps it.

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

// A tool (like flow-add-step) that owns its `args` field.
const flowAddStepMeta = {
  name: "flow-add-step",
  description: "Add a step to the active flow recording",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      args: { type: "string" },
      delayMs: { type: "integer" },
    },
    required: ["command"],
  },
};

// A tool (like gesture-tap) with NO `args` field.
const gestureTapMeta = {
  name: "gesture-tap",
  description: "Tap the screen",
  inputSchema: {
    type: "object",
    properties: {
      udid: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["udid", "x", "y"],
  },
};

// Unique text from the two suppressible whole-payload help lines.
const WHOLE_PAYLOAD_LINE = "Pass the entire payload as JSON";
const STDIN_SENTINEL_LINE = "Read the entire payload as JSON from stdin";

describe("argent run --help — whole-payload --args advertisement", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  function capturedHelp(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("advertises the whole-payload --args escape hatch for a tool without its own `args` field", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(gestureTapMeta);

    await run(["gesture-tap", "--help"], { paths: {} as never });

    const help = capturedHelp();
    expect(help).toContain(WHOLE_PAYLOAD_LINE);
    expect(help).toContain(STDIN_SENTINEL_LINE);
    // The tool call must never happen on the help path.
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("suppresses the whole-payload --args lines for a tool that declares its own `args` field", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(flowAddStepMeta);

    await run(["flow-add-step", "--help"], { paths: {} as never });

    const help = capturedHelp();
    expect(help).not.toContain(WHOLE_PAYLOAD_LINE);
    expect(help).not.toContain(STDIN_SENTINEL_LINE);
    // Its own `args` field is still shown as a per-field flag in the schema
    // block (rendered as `--args <value>` by formatSchemaUsage), so suppression
    // removes the whole-payload hatch without hiding the field itself.
    expect(help).toContain("--args <value>");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

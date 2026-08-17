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

// A tool (like flow-add-step) that owns its `args` field. Schema and
// description mirror what the registry advertises for the real tool -
// zodObjectToJsonSchema over the zod schema in
// packages/tool-server/src/tools/flows/flow-add-step.ts. Recordings are keyed
// by `name` + `project_root`, so both are required alongside `command` and only
// `args` / `delayMs` are optional. The assertions below pin `required` in both
// directions — each entry against its `(required)` marker, each non-entry
// against a negative lookahead — so dropping or adding one here fails loudly.
// The drift that does pass silently is the opposite one: if the real
// flow-add-step schema ever relaxes, nothing here notices this fixture went
// stale.
//
// This fixture is hand-copied: `@argent/cli` does not depend on the tool-server,
// so it cannot derive the schema. The guard that catches drift lives where the
// schema does — `flow-tools.test.ts`'s "the flow-add-step schema the CLI tests
// hand-copy". If that fails, this fixture is what it is telling you to update.
const flowAddStepMeta = {
  name: "flow-add-step",
  // Leading sentence of the real tool description, verbatim.
  description:
    "Execute a tool call and record it as a step in the flow named by `name` + `project_root` (the recording must already be open — see flow-start-recording).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      project_root: { type: "string" },
      command: { type: "string" },
      args: { type: "string" },
      delayMs: { type: "integer", minimum: 0, maximum: 9007199254740991 },
    },
    required: ["name", "project_root", "command"],
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

  it("renders each required flag with the (required) marker and leaves the optionals unmarked", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(flowAddStepMeta);

    await run(["flow-add-step", "--help"], { paths: {} as never });

    const help = capturedHelp();
    // The tool's own prose is printed ABOVE the flag block. Asserting mere
    // containment says almost nothing here — `help` is rendered from this same
    // fixture, so it reduces to `x.toContain(x)` and holds for any renderer
    // that emits the description anywhere at all, including below the flags.
    // Pin the placement, which is the part the renderer decides.
    const descriptionAt = help.indexOf(flowAddStepMeta.description);
    expect(descriptionAt).toBeGreaterThanOrEqual(0);
    expect(descriptionAt).toBeLessThan(help.indexOf("--name <value>"));
    // The recording identity is required alongside `command`: omitting either
    // flag fails the server's zod validation, so the help has to say so up front
    // instead of presenting them as optional extras.
    expect(help).toMatch(/--name <value>\s+string \(required\)/);
    expect(help).toMatch(/--project_root <value>\s+string \(required\)/);
    expect(help).toMatch(/--command <value>\s+string \(required\)/);
    // ...while the two genuinely optional fields must NOT carry the marker.
    expect(help).toMatch(/--args <value>\s+string(?! \(required\))/);
    expect(help).toMatch(/--delayMs <value>\s+integer(?! \(required\))/);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

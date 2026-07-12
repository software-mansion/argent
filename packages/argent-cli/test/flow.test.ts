import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flow, parseRunArgs } from "../src/flow.js";
import { FlagParseException } from "../src/flag-parser.js";

const toolsClientMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:4141", token: "tok" })),
}));

vi.mock("@argent/tools-client", () => ({
  createToolsClient: vi.fn(() => toolsClientMock),
  // Identity materialization — flow reports carry no artifact handles here.
  materializeArtifacts: vi.fn(async (data: unknown) => ({ result: data, images: [] })),
}));

interface StepFixture {
  index: number;
  kind: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  artifacts?: Record<string, unknown>;
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const steps: StepFixture[] = [{ index: 0, kind: "tap", status: "pass" }];
  return {
    flow: "checkout",
    device: "SIM-1",
    executionPrerequisite: "",
    ok: true,
    passed: 1,
    failed: 0,
    skipped: 0,
    errored: 0,
    steps,
    ...overrides,
  };
}

describe("parseRunArgs", () => {
  it("returns documented defaults with just a name", () => {
    expect(parseRunArgs(["checkout"])).toEqual({
      name: "checkout",
      updateBaselines: false,
      json: false,
    });
  });

  it("parses every run flag alongside the name", () => {
    expect(
      parseRunArgs(["checkout", "--device", "SIM-1", "--platform", "ios", "--update-baselines"])
    ).toEqual({
      name: "checkout",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: true,
      json: false,
    });
    expect(parseRunArgs(["--json", "checkout"]).json).toBe(true);
  });

  it("throws when --device is the final token", () => {
    expect(() => parseRunArgs(["checkout", "--device"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout", "--device"])).toThrow("--device requires a value");
  });

  it("throws when --platform is the final token", () => {
    expect(() => parseRunArgs(["checkout", "--platform"])).toThrow("--platform requires a value");
  });

  it("treats a following flag as a missing value, not as the value", () => {
    expect(() => parseRunArgs(["checkout", "--device", "--json"])).toThrow(
      "--device requires a value"
    );
    expect(() => parseRunArgs(["checkout", "--platform", "--update-baselines"])).toThrow(
      "--platform requires a value"
    );
  });

  it("accepts the --flag=value form for every value-taking flag", () => {
    expect(parseRunArgs(["checkout", "--device=SIM-1", "--platform=ios", "--output=dir"])).toEqual({
      name: "checkout",
      device: "SIM-1",
      platform: "ios",
      output: "dir",
      updateBaselines: false,
      json: false,
    });
  });

  it("mixes = and space-separated forms freely", () => {
    expect(parseRunArgs(["checkout", "--device=SIM-1", "--platform", "ios"])).toEqual({
      name: "checkout",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: false,
      json: false,
    });
  });

  it("does not consume the next token when the value was inline", () => {
    // Guards the index bookkeeping: --device=SIM-1 must not swallow --json.
    const out = parseRunArgs(["checkout", "--device=SIM-1", "--json"]);
    expect(out.device).toBe("SIM-1");
    expect(out.json).toBe(true);
  });

  it("throws when a boolean flag is given an inline value", () => {
    expect(() => parseRunArgs(["checkout", "--json=true"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout", "--json=true"])).toThrow("--json does not take a value");
    expect(() => parseRunArgs(["checkout", "--update-baselines=1"])).toThrow(
      "--update-baselines does not take a value"
    );
  });

  it("throws when an inline value is empty", () => {
    expect(() => parseRunArgs(["checkout", "--device="])).toThrow("--device requires a value");
  });

  it("rejects unknown flags instead of silently dropping them", () => {
    expect(() => parseRunArgs(["checkout", "--verbose"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout", "--verbose"])).toThrow(/unknown flag/);
    // A typo'd value flag must not fall back to device auto-detection.
    expect(() => parseRunArgs(["checkout", "--platfrom=ios"])).toThrow(/unknown flag/);
  });

  it("still ignores extra bare positionals (only flags are rejected)", () => {
    expect(parseRunArgs(["checkout", "extra"])).toEqual({
      name: "checkout",
      updateBaselines: false,
      json: false,
    });
  });
});

describe("argent flow run", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeEach(() => {
    vi.clearAllMocks();
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("forwards name, device, platform, and updateBaselines to flow-execute and exits 0 on pass", async () => {
    await expect(
      flow(
        ["run", "checkout", "--device", "SIM-1", "--platform", "ios", "--update-baselines"],
        opts
      )
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        name: "checkout",
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
        updateBaselines: true,
      },
      { onProgress: expect.any(Function) }
    );
    expect(logs.join("\n")).toContain("PASS — 1 passed, 0 failed, 0 errored, 0 skipped");
  });

  it("exits 2 without calling the tool when --device is missing its value", async () => {
    await expect(flow(["run", "checkout", "--device"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--device requires a value");
  });

  it("exits 2 without calling the tool when --platform is followed by another flag", async () => {
    await expect(flow(["run", "checkout", "--platform", "--json"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--platform requires a value");
  });

  it("forwards --flag=value forms to flow-execute like the space-separated ones", async () => {
    await expect(
      flow(["run", "checkout", "--platform=ios", "--device=SIM-1"], opts)
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        name: "checkout",
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("exits 2 without calling the tool when a boolean flag is given a value", async () => {
    await expect(flow(["run", "checkout", "--json=x"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--json does not take a value");
  });

  it("exits 2 without calling the tool on a typo'd flag instead of auto-detecting a device", async () => {
    await expect(flow(["run", "checkout", "--platfrom=ios"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("unknown flag");
  });

  it("exits 2 when no flow name is given", async () => {
    await expect(flow(["run"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain("requires a flow name");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("renders the report — echo lines unnumbered, real steps numbered, reasons and fragment tags shown — and exits 1 on failure", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        executionPrerequisite: "App on the login screen",
        ok: false,
        passed: 1,
        failed: 1,
        skipped: 1,
        steps: [
          { index: 0, kind: "echo", status: "pass", message: "Opening settings" },
          { index: 1, kind: "tap", status: "pass" },
          { index: 2, kind: "assert", status: "fail", reason: "never visible", flow: "login" },
          { index: 3, kind: "tool", tool: "screenshot", status: "skip" },
        ],
      }),
    });

    await expect(flow(["run", "checkout"], opts)).rejects.toThrow("process.exit:1");

    const out = logs.join("\n");
    expect(out).toContain('Flow "checkout" on SIM-1');
    expect(out).toContain("assumes: App on the login screen");
    // Echo is narration — no index; numbering starts at the first real step.
    expect(out).toContain("› Opening settings");
    expect(out).toMatch(/✓ {2}1 tap/);
    expect(out).toMatch(/✗ {2}2 assert \[login\] — never visible/);
    expect(out).toMatch(/· {2}3 tool screenshot/);
    expect(out).toContain("FAIL — 1 passed, 1 failed, 0 errored, 1 skipped");
  });

  it("renders legacy warnings with the ⚠ glyph and counts them in the summary", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [{ index: 0, kind: "snapshot", status: "pass", warning: "no baseline; adopted" }],
      }),
    });

    await expect(flow(["run", "checkout"], opts)).rejects.toThrow("process.exit:0");

    const out = logs.join("\n");
    expect(out).toMatch(/⚠ {2}1 snapshot/);
    expect(out).toContain("⚠ no baseline; adopted");
    expect(out).toContain("1 warning");
  });

  it("prints the raw report with --json", async () => {
    await expect(flow(["run", "checkout", "--json"], opts)).rejects.toThrow("process.exit:0");
    expect(JSON.parse(logs.join("\n"))).toEqual(report());
  });

  it("exits 1 with the error message when the tool call fails", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("tool-server unreachable"));

    await expect(flow(["run", "checkout"], opts)).rejects.toThrow("process.exit:1");
    expect(errs.join("\n")).toContain("tool-server unreachable");
  });

  it("exits 2 when the result is not a run report (e.g. a prerequisite notice)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: { flow: "checkout", notice: "prerequisite", executionPrerequisite: "logged in" },
    });

    await expect(flow(["run", "checkout"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('"checkout" did not produce a run report');
  });

  it("exits 2 on an unknown subcommand", async () => {
    await expect(flow(["frobnicate"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('Unknown flow subcommand "frobnicate"');
  });

  it("prints help and returns (no exit) with no subcommand", async () => {
    await flow([], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when --help follows the flow name", async () => {
    await flow(["run", "checkout", "--help"], opts);
    expect(logs.join("\n")).toContain("Options (run):");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when -h trails other run flags", async () => {
    await flow(["run", "checkout", "--device", "SIM-1", "-h"], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

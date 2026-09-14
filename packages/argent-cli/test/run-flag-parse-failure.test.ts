import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodObjectToJsonSchema } from "@argent/registry";
import { run } from "../src/run.js";

// A flag the parser refuses is a rejected invocation like any other, so it owes `--json` callers
// the same contract the missing-required and server-rejected paths keep: one object on stderr,
// nothing on stdout. It used to answer with the human help block on stdout regardless, which puts
// prose in the result channel and makes `--json | jq` a parse error. The defect is general, so a
// plain bad-number typo is pinned beside the retired-key refusal.

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

const RETIREMENT_NOTE =
  "Retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key.";

// The refusal text, assembled by the parser from the note above with its "Retired: " label
// dropped. Pinned whole so the message a `--json` caller reads is the message a human reads.
const REFUSAL =
  "--settle is retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key.";

// Run the real registry serializer over a real zod object rather than hand-writing the
// `{description, not: {}}` shape a retired key produces, so this fixture cannot drift from what
// the tool-server actually publishes. `flag-parser.test.ts` pins the shape itself.
const gestureSwipeMeta = {
  name: "gesture-swipe",
  description: "Execute a smooth swipe / drag touch gesture between two points",
  inputSchema: zodObjectToJsonSchema(
    z.object({
      udid: z.string().describe("Target device"),
      durationMs: z.number().optional().describe("Total gesture duration in milliseconds"),
      momentum: z.boolean().optional().describe("Whether the swipe releases with momentum"),
      settle: z
        .never({ error: "`settle` was renamed to `momentum`, with the opposite sense" })
        .optional()
        .describe(RETIREMENT_NOTE),
    })
  ),
};

const invoke = (argv: string[]) => run(argv, { paths: {} as never });

function joined(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
}

describe("argent run - a flag the parser refuses", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const stderr = () => joined(errorSpy);
  const stdout = () => joined(logSpy);

  beforeEach(() => {
    vi.clearAllMocks();
    toolsClientMock.fetchTool.mockResolvedValue(gestureSwipeMeta);
    toolsClientMock.callTool.mockResolvedValue({ data: { swiped: true } });
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

  describe("with --json", () => {
    it("answers a retired key with one object on stderr and nothing on stdout", async () => {
      await expect(
        invoke(["gesture-swipe", "--json", "--udid", "X", "--settle", "true"])
      ).rejects.toThrow("process.exit:2");

      // The whole point: `--json | jq` must read an empty stream, not the help block.
      expect(logSpy).not.toHaveBeenCalled();
      const envelope = JSON.parse(stderr());
      expect(envelope).toEqual({ error: REFUSAL, missing: [], issues: [] });
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    });

    it("answers an ordinary bad value the same way", async () => {
      await expect(
        invoke(["gesture-swipe", "--json", "--udid", "X", "--durationMs", "abc"])
      ).rejects.toThrow("process.exit:2");

      expect(logSpy).not.toHaveBeenCalled();
      const envelope = JSON.parse(stderr());
      expect(envelope.error).toContain("--durationMs");
      expect(envelope).toMatchObject({ missing: [], issues: [] });
    });

    it("carries the same keys as a missing-required failure", async () => {
      // A scripted caller reads `.error` without first working out which failure it hit, so the
      // two envelopes must not differ in shape - only in what fills them.
      await expect(invoke(["gesture-swipe", "--json", "--settle", "true"])).rejects.toThrow(
        "process.exit:2"
      );
      const parseKeys = Object.keys(JSON.parse(stderr()));

      vi.clearAllMocks();
      await expect(invoke(["gesture-swipe", "--json"])).rejects.toThrow("process.exit:2");
      const validationEnvelope = JSON.parse(stderr());

      expect(Object.keys(validationEnvelope)).toEqual(parseKeys);
      expect(validationEnvelope.error).toBe("missing required flag --udid");
    });

    it("still reports the parse-flags telemetry signal, not the validation one", async () => {
      await expect(invoke(["gesture-swipe", "--json", "--settle", "true"])).rejects.toThrow(
        "process.exit:2"
      );

      expect(telemetryMock.track).toHaveBeenCalledWith(
        "cli:run_fail",
        expect.objectContaining({
          tool: "gesture-swipe",
          error_code: "CLI_RUN_FLAG_PARSE_FAILED",
          failure_stage: "cli_run_parse_flags",
          failure_area: "cli",
          error_kind: "validation",
        })
      );
      expect(telemetryMock.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe("without --json", () => {
    // Pinned so routing the parse failure through the shared reporter cannot quietly swallow the
    // human path: the message still goes to stderr and the help block still goes to stdout.
    it("keeps the retired-key refusal on stderr and the help block on stdout", async () => {
      await expect(invoke(["gesture-swipe", "--udid", "X", "--settle", "true"])).rejects.toThrow(
        "process.exit:2"
      );

      expect(stderr()).toContain(`Error: ${REFUSAL}`);
      expect(stdout()).toContain("argent run gesture-swipe [flags]");
      expect(stdout()).toContain("--momentum");
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    });

    it("keeps an ordinary bad value on stderr with the help block on stdout", async () => {
      await expect(invoke(["gesture-swipe", "--udid", "X", "--durationMs", "abc"])).rejects.toThrow(
        "process.exit:2"
      );

      expect(stderr()).toContain("Error: --durationMs");
      expect(stdout()).toContain("argent run gesture-swipe [flags]");
    });
  });
});

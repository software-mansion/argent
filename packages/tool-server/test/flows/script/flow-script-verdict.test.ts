import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { scriptVerdict, type ScriptRan } from "../../../src/tools/flows/flow-script-step";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";
import type {
  FlowScriptFailureKind,
  FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../../src/tools/flows/script/flow-script-executor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/tools/flows/script/flow-script-executor")>();
  return { ...actual, flowScriptExecutor: () => ({ execute: executeMock }) };
});

let root: string;

function outcome(over: Partial<FlowScriptResult>): FlowScriptResult {
  return {
    ok: false,
    durationMs: 1,
    queuedMs: 0,
    notes: [],
    ...over,
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async () => ({ devices: [] })),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({})),
  } as unknown as Registry;
}

async function runScript(): Promise<FlowRunResult["steps"][number]> {
  const result = (await createRunFlowTool(mockRegistry()).execute({}, {
    name: "verdict",
    project_root: root,
  } as never)) as FlowRunResult;
  return result.steps[0]!;
}

async function recordScript(ctx?: ToolContext) {
  await flowStartRecordingTool.execute({}, { name: "recorded", project_root: root });
  return flowAddScriptTool.execute(
    {},
    {
      name: "recorded",
      project_root: root,
      path: "../../scripts/seed.mjs",
    } as never,
    ctx
  );
}

function executedRequest(): Record<string, unknown> {
  return executeMock.mock.calls[0]![0] as Record<string, unknown>;
}

async function recordedSteps() {
  return parseFlow(await fs.readFile(path.join(root, ".argent", "flows", "recorded.yaml"), "utf8"))
    .steps;
}

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-verdict-"));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "scripts", "seed.mjs"), "");
  await fs.writeFile(
    path.join(root, ".argent", "flows", "verdict.yaml"),
    "steps:\n  - script: { path: ../../scripts/seed.mjs }\n",
    "utf8"
  );
  executeMock.mockReset();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

const VERDICTS: Record<FlowScriptFailureKind, "fail" | "error"> = {
  load: "fail",
  runtime: "fail",
  output: "fail",
  exit: "fail",
  protocol: "error",
  timeout: "error",
  cancelled: "error",
  signal: "error",
  heap: "error",
  spawn: "error",
  queue: "error",
  invalid: "error",
};

/**
 * Whether each failure leaves the author something to clean up, judged from the
 * KIND alone — the answer for a failure the executor did not mark `beforeFork`.
 * Total over the kinds, like {@link VERDICTS}: the dangerous mapping is a kind
 * that DID fork being told "nothing ran", and a table listing only some kinds
 * stays green while a kind moves in or out of the never-forked set.
 */
const RAN: Record<FlowScriptFailureKind, ScriptRan> = {
  queue: "no",
  spawn: "no",
  invalid: "no",
  protocol: "unknown",
  load: "yes",
  runtime: "yes",
  output: "yes",
  exit: "yes",
  timeout: "yes",
  cancelled: "yes",
  signal: "yes",
  heap: "yes",
};

/** The move each answer asks the author to make. */
const NEXT_MOVE: Record<ScriptRan, string> = {
  yes: "Check or restore its changes before you retry",
  no: "Fix the reason before you retry",
  unknown: "Check its changes before you retry",
};

/** How the same answer opens, anchored so a later "failed" cannot match it. */
const LEAD: Record<ScriptRan, string> = {
  yes: "failed",
  no: "did not run",
  unknown: "may have run",
};

function headline(ran: ScriptRan): string {
  return `Script "../../scripts/seed.mjs" ${LEAD[ran]};`;
}

describe("which side of the fail/error line a script failure lands on", () => {
  it.each(Object.entries(VERDICTS))("reports a %s failure as %s", async (kind, status) => {
    executeMock.mockResolvedValue(
      outcome({ failure: { kind: kind as FlowScriptFailureKind, message: `the ${kind} message` } })
    );

    expect(await runScript()).toMatchObject({
      kind: "script",
      status,
      reason: `the ${kind} message`,
    });
  });

  it("errors, rather than blaming the flow, for a result carrying no failure at all", async () => {
    executeMock.mockResolvedValue(outcome({ ok: false }));

    expect(await runScript()).toMatchObject({
      status: "error",
      reason: "Script failed without a reason.",
    });
  });
});

describe("an executor note on the step report", () => {
  it("rides into the reason of a step that PASSED", async () => {
    executeMock.mockResolvedValue(
      outcome({
        ok: true,
        output: {},
        notes: ["timeout clamped to 300000ms.", "project_root did not exist."],
      })
    );

    expect(await runScript()).toMatchObject({
      status: "pass",
      reason: "timeout clamped to 300000ms. project_root did not exist.",
    });
  });

  it("leaves a quiet pass with no reason at all", async () => {
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

    const step = await runScript();
    expect(step).toMatchObject({ status: "pass" });
    expect(step).not.toHaveProperty("reason");
  });

  it("follows the failure message rather than replacing it", async () => {
    executeMock.mockResolvedValue(
      outcome({
        failure: { kind: "timeout", message: "The script ran past its 1000ms limit." },
        notes: ["timeout clamped to 1000ms."],
      })
    );

    expect(await runScript()).toMatchObject({
      status: "error",
      reason: "The script ran past its 1000ms limit. timeout clamped to 1000ms.",
    });
  });
});

describe("the recorder reports the verdict the runner will", () => {
  it.each(Object.keys(VERDICTS) as FlowScriptFailureKind[])(
    "agrees with the runner about a %s failure",
    async (kind) => {
      const result = outcome({ failure: { kind, message: `the ${kind} message` } });
      executeMock.mockResolvedValue(result);

      const replayed = await runScript();
      const recorded = await recordScript();

      expect(recorded.status).toBe(scriptVerdict(result).status);
      expect(recorded.status).toBe(replayed.status);
      expect(recorded.reason).toBe(replayed.reason);
      expect(await recordedSteps()).toEqual([]);
    }
  );

  it.each(Object.entries(RAN) as [FlowScriptFailureKind, ScriptRan][])(
    "tells the author whether a %s failure left anything behind",
    async (kind, ran) => {
      // The executor answers three of its failures WITHOUT forking anything, so
      // "there is a result" does not mean "something ran", and telling an
      // author to clean up after a queue that was full sends them hunting for
      // state that was never created. `cancelled` counts as ran only once the
      // executor has NOT marked it `beforeFork` - the half of that kind which
      // stopped a process that was already running. `protocol` is the runner
      // failing around the script - almost always before the script began, but
      // reachable from a script that has already done its work, so it claims
      // neither.
      executeMock.mockResolvedValue(outcome({ failure: { kind, message: `the ${kind} message` } }));

      const recorded = await recordScript();

      expect(recorded.status).not.toBe("pass");
      expect(recorded.message).toContain(NEXT_MOVE[ran]);
      expect(recorded.message).toContain(headline(ran));
      // The headline is the clause an agent acts on first, so it may not answer
      // "is there state to check?" differently from the move that follows it.
      for (const other of Object.keys(NEXT_MOVE) as ScriptRan[]) {
        if (other !== ran) expect(recorded.message).not.toContain(headline(other));
      }
      expect(await recordedSteps()).toEqual([]);
    }
  );

  // The executor's own answer outranks the table above: `cancelled` is the one
  // kind that reaches this tool from both sides of the fork, and the executor
  // marks the failures it raised before there was a child to run anything.
  it.each(Object.keys(RAN) as FlowScriptFailureKind[])(
    "believes the executor over the kind when a %s failure never forked",
    async (kind) => {
      executeMock.mockResolvedValue(
        outcome({ failure: { kind, message: `the ${kind} message`, beforeFork: true } })
      );

      const recorded = await recordScript();

      expect(recorded.message).toContain(NEXT_MOVE.no);
      expect(recorded.message).toContain(headline("no"));
      expect(recorded.message).not.toContain(NEXT_MOVE.yes);
      expect(recorded.message).not.toContain(NEXT_MOVE.unknown);
      expect(await recordedSteps()).toEqual([]);
    }
  );

  it("agrees on a pass, and only then records the step", async () => {
    const result = outcome({ ok: true, output: { order: { id: 7 } }, notes: ["a note."] });
    executeMock.mockResolvedValue(result);

    const replayed = await runScript();
    const recorded = await recordScript();

    expect(recorded.status).toBe("pass");
    expect(recorded.status).toBe(replayed.status);
    expect(recorded.reason).toBe(replayed.reason);
    expect(recorded.outputJson).toBe('{"order":{"id":7}}');
    expect(await recordedSteps()).toEqual([{ kind: "script", path: "../../scripts/seed.mjs" }]);
  });

  it("hands the executor the caller's cancellation signal", async () => {
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));
    const controller = new AbortController();

    await recordScript({ signal: controller.signal } as unknown as ToolContext);

    expect(executedRequest().signal).toBe(controller.signal);
  });

  it("passes no signal when the caller has none", async () => {
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

    await recordScript();

    expect("signal" in executedRequest()).toBe(false);
  });
});

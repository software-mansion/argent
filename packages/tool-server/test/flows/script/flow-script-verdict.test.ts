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
    log: "",
    logTruncated: false,
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

const NEXT_MOVE: Record<ScriptRan, string> = {
  yes: "Check or restore its changes before you retry",
  no: "Fix the reason before you retry",
  unknown: "Check its changes before you retry",
};

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
      executeMock.mockResolvedValue(outcome({ failure: { kind, message: `the ${kind} message` } }));

      const recorded = await recordScript();

      expect(recorded.status).not.toBe("pass");
      expect(recorded.message).toContain(NEXT_MOVE[ran]);
      expect(recorded.message).toContain(headline(ran));
      for (const other of Object.keys(NEXT_MOVE) as ScriptRan[]) {
        if (other !== ran) expect(recorded.message).not.toContain(headline(other));
      }
      expect(await recordedSteps()).toEqual([]);
    }
  );

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

describe("which interpreter the step asks the executor for", () => {
  it.each([
    ["seed.mjs", "node"],
    ["seed.sh", "bash"],
  ])("asks for %s to run under %s", async (file, interpreter) => {
    await fs.writeFile(path.join(root, "scripts", file), "");
    await fs.writeFile(
      path.join(root, ".argent", "flows", "verdict.yaml"),
      `steps:\n  - script: { path: ../../scripts/${file} }\n`,
      "utf8"
    );
    executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

    await runScript();

    expect(executedRequest().interpreter).toBe(interpreter);
  });

  it.each([
    ["an extensionless target", "extensionless", "seed", "bash"],
    ["a target of the other language", "other-language", "seed.mjs", "node"],
  ])(
    "reads the interpreter of a linked .sh through %s",
    async (_label, link, target, interpreter) => {
      await fs.mkdir(path.join(root, "tools"), { recursive: true });
      await fs.writeFile(path.join(root, "tools", target), "");
      await fs.symlink(path.join(root, "tools", target), path.join(root, "scripts", `${link}.sh`));
      await fs.writeFile(
        path.join(root, ".argent", "flows", "verdict.yaml"),
        `steps:\n  - script: { path: ../../scripts/${link}.sh }\n`,
        "utf8"
      );
      executeMock.mockResolvedValue(outcome({ ok: true, output: {} }));

      await runScript();

      expect(executedRequest().interpreter).toBe(interpreter);
    }
  );
});

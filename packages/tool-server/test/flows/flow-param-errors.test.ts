import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, getFailureSignal, FAILURE_CODES } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { InvalidToolInputError } from "../../src/utils/capability";

// An agent passed `flow_name` instead of `name` and got back
//   [{"expected":"string","code":"invalid_type","path":["name"]}]
// which names the parameter the tool wanted and never the one that was sent —
// so the mistake is invisible, and finding it costs a whole turn.

let tmpDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  return r;
}

async function writeFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    `executionPrerequisite: "anywhere"\nsteps:\n  - echo: hello\n`,
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-params-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("flow-execute parameter handling", () => {
  it("accepts `flow_name` as an alias for `name`", async () => {
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("prefers `name` over `flow_name` when both are sent (matches the file-input merge)", async () => {
    // `name || flow_name`: when both resolve, `name` wins — and the client's
    // file-input merge puts the `name` spec last for the same precedence, so
    // the file executed is always the one resolveFlowName reports.
    await writeFlow("by-name");
    await writeFlow("by-alias");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      name: "by-name",
      flow_name: "by-alias",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("by-name");
    expect(result.ok).toBe(true);
  });

  it("does not let an EMPTY name mask a valid alias", async () => {
    // `??` would keep `""` and reject the call while pointing at the very
    // field it ignored — the exact confusion the alias exists to prevent.
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      name: "",
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("names an invalid enum value by its parameter, not as raw Zod JSON", async () => {
    // `platform` is a recognized top-level key with an invalid value — this
    // exercises the generic per-issue prose, not the missing/nested branches
    // (flow-execute's flat schema has no nested path to reach; those branches
    // are covered directly in registry's describe-param-issues.test.ts).
    let message = "";
    try {
      await registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        name: "x",
        platform: "not-a-platform",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("`platform`");
    expect(message).not.toContain('"code"');
  });

  it("says which parameter it needs when neither spelling is present", async () => {
    // Answered by the schema's exactly-one-source rule, whose message was given
    // the same wording as resolveFlowName's so both reads are one answer.
    await expect(
      registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("classifies a source-less call as a client-input VALIDATION error, not an internal fault", async () => {
    // Whichever check catches it, this must carry a validation signal so the
    // HTTP boundary maps it to 400 and telemetry does not log it as
    // ARGENT_UNCLASSIFIED_FAILURE — the classification the pre-alias
    // zod-rejection it replaced already had.
    let caught: unknown;
    try {
      await registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      });
    } catch (err) {
      caught = err;
    }
    const signal = getFailureSignal(caught);
    expect(signal?.error_kind).toBe("validation");
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
  });

  it("reaches resolveFlowName's own rejection for an EMPTY name, and classifies it too", async () => {
    // The source-less cases above never enter `execute` — the schema's
    // exactly-one rule fires first, and it was given the same wording, so those
    // assertions hold whatever resolveFlowName throws (or whether it runs at
    // all). An empty `name` is a named source as far as that rule is concerned,
    // so it is the ONE input that reaches the throw: zod passes, execute runs.
    // Spy on it, or this test drifts back into proving the schema.
    const r = new Registry();
    const tool = createRunFlowTool(r);
    const execute = vi.spyOn(tool, "execute");
    r.registerTool(tool as never);

    for (const params of [{ name: "" }, { flow_name: "" }, { name: "", flow_name: "" }]) {
      const caught = await r
        .invokeTool("flow-execute", { ...params, project_root: tmpDir })
        .then(() => undefined)
        .catch((err: unknown) => err);

      // The registry wraps whatever execute throws, so the CLASS the HTTP
      // boundary maps to 400 has to be found on the cause — a plain Error here
      // would leave the same call a 500.
      expect((caught as Error).cause, JSON.stringify(params)).toBeInstanceOf(InvalidToolInputError);
      expect((caught as Error).message).toContain("needs the flow's name in `name`");
      const signal = getFailureSignal(caught);
      expect(signal?.error_kind).toBe("validation");
      expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    }
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("renders a schema failure as a sentence naming what was sent", async () => {
    let message = "";
    try {
      await registry().invokeTool("flow-execute", { name: "x" }); // project_root missing
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("`project_root` is required");
    // The other half of the fix: name the keys the caller actually sent, so a
    // misspelling is self-evident instead of merely absent.
    expect(message).toContain("You sent: `name`");
    // And not the raw issue JSON.
    expect(message).not.toContain('"code":"invalid_type"');
  });

  it("never renders 'undefined' in the interaction line for a name-less call", () => {
    // The interaction message fires inside `invokeTool` BEFORE `execute`, so it
    // is emitted even for the name-less call `resolveFlowName` later rejects.
    // It must not read "Running flow undefined" in the event log, telemetry or
    // MCP progress; and the alias path must still show the real flow name.
    const tool = createRunFlowTool(new Registry());
    const nameless = tool.interaction!.startedMsg!({ params: { project_root: "/x" } as never });
    expect(nameless).not.toContain("undefined");
    const aliased = tool.interaction!.startedMsg!({ params: { flow_name: "feeds" } as never });
    expect(aliased).toContain("feeds");
  });
});

describe("flow-read-prerequisite parameter handling", () => {
  function prereqRegistry(): Registry {
    const r = new Registry();
    r.registerTool(flowReadPrerequisiteTool as never);
    return r;
  }

  it("accepts the alias THROUGH the schema, not only via a direct execute()", async () => {
    // The tool's own alias tests call `.execute()` directly, which bypasses zod
    // entirely — so the schema could stop accepting `flow_name` (or start
    // stripping it) and they would all stay green. Go through the registry,
    // which validates on every dispatch path.
    await writeFlow("prereq-aliased");

    const result = await prereqRegistry().invokeTool<{
      flow: string;
      executionPrerequisite: string;
    }>("flow-read-prerequisite", { flow_name: "prereq-aliased", project_root: tmpDir });

    expect(result.flow).toBe("prereq-aliased");
    expect(result.executionPrerequisite).toBe("anywhere");
  });

  it("advertises both spellings in the oneOf it publishes to MCP and HTTP clients", () => {
    // superRefine cannot be expressed in JSON Schema, so `oneOf` is the only
    // machine-readable statement of the rule a client sees. It has to name the
    // alias, or a client generating calls from the schema never learns of it.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      expect(tool.inputSchema!.oneOf, tool.id).toEqual([
        { anyOf: [{ required: ["name"] }, { required: ["flow_name"] }] },
        { required: ["flow_path"] },
      ]);
    }
  });

  it("spells out the alias when neither flow source is present", async () => {
    // The documented pre-flight: the skill has agents call this BEFORE the run,
    // so a caller who named the flow under a key zod stripped meets this tool
    // first. A bare "Pass exactly one flow source" leaves them with nothing
    // saying which spellings are accepted, while the run itself would say.
    await expect(
      prereqRegistry().invokeTool("flow-read-prerequisite", { project_root: tmpDir })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("anchors the exactly-one-source rule at the ROOT, not on flow_path", async () => {
    // The rule spans the source fields and its message names them all, so it
    // must not be attributed to one of them. Anchored on `flow_path` it renders
    // as "`flow_path`: Pass exactly one flow source…" to an agent and
    // "--flow_path Pass exactly one flow source…" to `argent run` — both
    // pointing at the field the caller is as likely as not to have got right.
    // An empty path is what makes both surfaces print the sentence alone.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const parsed = tool.zodSchema!.safeParse({ project_root: tmpDir });
      expect(parsed.success, tool.id).toBe(false);
      const sourceIssues = parsed.error!.issues.filter((i) =>
        i.message.includes("Pass exactly one flow source")
      );
      expect(sourceIssues, tool.id).toHaveLength(1);
      expect(sourceIssues[0].path, tool.id).toEqual([]);
    }
  });

  it("stays terse when the caller named BOTH sources", async () => {
    // Two sources named is not a spelling problem — the caller has to drop one,
    // and the alias hint would only be noise.
    let message = "";
    try {
      await prereqRegistry().invokeTool("flow-read-prerequisite", {
        name: "a",
        flow_path: path.join(tmpDir, "b.yaml"),
        project_root: tmpDir,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Pass exactly one flow source: name or flow_path.");
    expect(message).not.toContain("is accepted as an alias");
  });
});

describe("flow-file file-input spec order", () => {
  it("puts the `${flow_name}` spec before the `${name}` spec so `name` wins the client merge", () => {
    // The client interpolates each spec and merges last-write-wins on `target`,
    // so the `name` spec must come LAST to match `resolveFlowName`'s
    // `name || flow_name` precedence. If it did not, a REMOTE call sending both
    // keys would upload the `flow_name` file while the run reports `name` — a
    // silent divergence between the flow executed and the flow named. The
    // client's own merge is unit-tested against a hand-built array, which would
    // not catch a reorder of THESE production specs.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const flowFilePaths = (tool.fileInputs ?? [])
        .filter((spec) => spec.target === "flow_file")
        .map((spec) => spec.path);
      expect(flowFilePaths, tool.id).toEqual([
        "${project_root}/.argent/flows/${flow_name}.yaml",
        "${project_root}/.argent/flows/${name}.yaml",
      ]);
    }
  });
});

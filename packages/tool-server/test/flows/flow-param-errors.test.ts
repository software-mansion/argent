import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, getFailureSignal, FAILURE_CODES, zodObjectToJsonSchema } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { InvalidToolInputError } from "../../src/utils/capability";

// An agent passing `flow_name` instead of `name` got back raw Zod JSON naming
// neither spelling usefully: an `invalid_type` on `name` where it is required,
// and on flow-execute the exactly-one-source rule anchored on `flow_path` — the
// one source field the caller had no reason to send. Either way the mistake is
// invisible, and finding it costs a whole turn.

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
    // HTTP boundary maps it to 400 and telemetry does not log
    // ARGENT_UNCLASSIFIED_FAILURE — the classification the pre-alias zod
    // rejection already had.
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
    // exactly-one rule fires first with the same wording — so they hold
    // whatever resolveFlowName does. An empty `name` counts as a named source
    // to that rule, so it is the ONE input that reaches the throw. Spy on it,
    // or this test drifts back into proving the schema.
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

  it("names only the keys the flow AUTHOR wrote, not the bound device key", async () => {
    // `bindDeviceArgs` re-injects the resolved device key, so `udid` is always
    // present and never came from the YAML — the recorder strips it so flows
    // stay portable. Listing it beside the misspelling the list exists to
    // expose points at a key the author cannot have written. This pins the flow
    // runner to the sentence run-sequence already renders.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "typo.yaml"),
      `steps:\n  - tool: gesture-tap\n    args:\n      xx: 0.5\n      y: 0.5\n`,
      "utf8"
    );

    // A real Registry with a real schema: the rejection has to come from the
    // same check the live dispatch runs, and a stub `invokeTool` would not run
    // one at all.
    const r = new Registry();
    r.registerTool(createRunFlowTool(r) as never);
    r.registerTool({
      id: "gesture-tap",
      description: "test double for gesture-tap",
      zodSchema: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
      services: () => ({}),
      execute: async () => ({ tapped: true }),
    } as never);

    const result = await r.invokeTool<FlowRunResult>("flow-execute", {
      name: "typo",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    const step = result.steps.find((s) => s.tool === "gesture-tap")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("`x` is required");
    expect(step.reason).toContain("You sent: `xx`, `y`.");
    expect(step.reason).not.toContain("`udid`");
  });

  it("leaves a tool's OWN input rejection alone when the dispatched args parsed fine", async () => {
    // `describeNestedParamError` gates on `TOOL_INPUT_INVALID`, which
    // `InvalidToolInputError` also DEFAULTS to — so a tool rejecting its
    // arguments from inside `execute` passes that gate with args that parse
    // fine. `resolveFlowName` is exactly that throw, and this step reaches it.
    // There is no zod error to re-render then, and reaching for one throws
    // `Cannot read properties of undefined (reading 'issues')`.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "nested-empty.yaml"),
      `steps:\n  - tool: flow-execute\n    args:\n      name: ""\n      project_root: ${tmpDir}\n      prerequisiteAcknowledged: true\n`,
      "utf8"
    );

    const r = new Registry();
    r.registerTool(createRunFlowTool(r) as never);

    const result = await r.invokeTool<FlowRunResult>("flow-execute", {
      name: "nested-empty",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    const step = result.steps.find((s) => s.tool === "flow-execute")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("needs the flow's name in `name`");
    expect(step.reason).not.toContain("Cannot read properties of undefined");
  });
});

describe("flow-read-prerequisite parameter handling", () => {
  function prereqRegistry(): Registry {
    const r = new Registry();
    r.registerTool(flowReadPrerequisiteTool as never);
    return r;
  }

  it("accepts the alias THROUGH the schema, not only via a direct execute()", async () => {
    // The tool's own alias tests call `.execute()` directly, bypassing zod — so
    // the schema could stop accepting `flow_name` and they would stay green. Go
    // through the registry, which validates on every dispatch path.
    await writeFlow("prereq-aliased");

    const result = await prereqRegistry().invokeTool<{
      flow: string;
      executionPrerequisite: string;
    }>("flow-read-prerequisite", { flow_name: "prereq-aliased", project_root: tmpDir });

    expect(result.flow).toBe("prereq-aliased");
    expect(result.executionPrerequisite).toBe("anywhere");
  });

  it("advertises both spellings in the schema it publishes to MCP and HTTP clients", () => {
    // A client generating calls from the schema must be able to learn of the
    // alias. A top-level `oneOf` naming both spellings is out: the Anthropic
    // Messages API rejects a top-level combinator with a 400 that fails every
    // tool in the request (#773). So the alias has to be legible from the
    // published `properties` — `flow_name` as its own field, described as an
    // alias.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const schema = zodObjectToJsonSchema(tool.zodSchema!) as {
        properties: Record<string, { description?: string }>;
        required?: string[];
      };

      expect(Object.keys(schema.properties), tool.id).toEqual(
        expect.arrayContaining(["name", "flow_name", "flow_path"])
      );
      expect(schema.properties.flow_name.description, tool.id).toMatch(/alias for `name`/i);

      // Neither spelling may be `required`, or the alias-only call the previous
      // tests make would be rejected before the tool ever runs.
      expect(schema.required ?? [], tool.id).not.toContain("name");
      expect(schema.required ?? [], tool.id).not.toContain("flow_name");
      expect(schema.required ?? [], tool.id).not.toContain("flow_path");
    }
  });

  it("spells out the alias when neither flow source is present", async () => {
    // The documented pre-flight: the skill has agents call this BEFORE the run,
    // so a caller who named the flow under a key zod stripped meets this tool
    // first. A bare "Pass exactly one flow source" would leave them with
    // nothing saying which spellings are accepted.
    await expect(
      prereqRegistry().invokeTool("flow-read-prerequisite", { project_root: tmpDir })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("anchors the exactly-one-source rule at the ROOT, not on flow_path", async () => {
    // The rule spans the source fields, so it must not be attributed to one.
    // Anchored on `flow_path` it renders as "`flow_path`: Pass exactly one flow
    // source…" to an agent and "--flow_path …" to `argent run`, both pointing
    // at a field the caller may well have got right. An empty path makes both
    // surfaces print the sentence alone.
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
    // `name || flow_name` precedence. Otherwise a REMOTE call sending both keys
    // uploads the `flow_name` file while the run reports `name`. The client's
    // own merge is unit-tested against a hand-built array, which would not
    // catch a reorder of THESE specs.
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

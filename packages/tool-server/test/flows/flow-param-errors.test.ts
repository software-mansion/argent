import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, getFailureSignal, FAILURE_CODES, zodObjectToJsonSchema } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { InvalidToolInputError } from "../../src/utils/capability";

let tmpDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-params-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("flow-execute parameter handling", () => {
  it("names an invalid enum value by its parameter, not as raw Zod JSON", async () => {
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

  it("says which parameter it needs when no flow source is present", async () => {
    await expect(
      registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/needs the flow's name in `name`.*\.argent\/flows\/<name>\.yaml/s);
  });

  it("classifies a source-less call as a client-input VALIDATION error, not an internal fault", async () => {
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

  it("renders a schema failure as a sentence naming what was sent", async () => {
    let message = "";
    try {
      await registry().invokeTool("flow-execute", { name: "x" }); // project_root missing
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("`project_root` is required");
    expect(message).toContain("You sent: `name`");
    expect(message).not.toContain('"code":"invalid_type"');
  });

  it("never renders 'undefined' in the interaction line for a name-less call", () => {
    const tool = createRunFlowTool(new Registry());
    const nameless = tool.interaction!.startedMsg!({ params: { project_root: "/x" } as never });
    expect(nameless).not.toContain("undefined");
  });

  it("names only the keys the flow AUTHOR wrote, not the bound device key", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "typo.yaml"),
      `steps:\n  - tool: gesture-tap\n    args:\n      xx: 0.5\n      y: 0.5\n`,
      "utf8"
    );

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
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "nested-own.yaml"),
      `steps:\n  - tool: picky\n    args:\n      mode: loud\n`,
      "utf8"
    );

    const r = new Registry();
    r.registerTool(createRunFlowTool(r) as never);
    r.registerTool({
      id: "picky",
      description: "test double that rejects its own already-parsed arguments",
      zodSchema: z.object({ mode: z.string() }),
      services: () => ({}),
      execute: async () => {
        throw new InvalidToolInputError('picky has no "loud" mode');
      },
    } as never);

    const result = await r.invokeTool<FlowRunResult>("flow-execute", {
      name: "nested-own",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    const step = result.steps.find((s) => s.tool === "picky")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain('picky has no "loud" mode');
    expect(step.reason).not.toContain("Invalid params for tool");
  });
});

describe("flow-read-prerequisite parameter handling", () => {
  function prereqRegistry(): Registry {
    const r = new Registry();
    r.registerTool(flowReadPrerequisiteTool as never);
    return r;
  }

  it("publishes both flow sources as OPTIONAL properties", () => {
    // A top-level `oneOf` over the two sources is not an option: the Anthropic
    // Messages API rejects a top-level combinator (#773). Either source marked
    // `required` would reject every call naming the other one, so the choice is
    // legible only from the published `properties` plus the message below.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const schema = zodObjectToJsonSchema(tool.zodSchema!) as {
        properties: Record<string, { description?: string }>;
        required?: string[];
      };

      expect(Object.keys(schema.properties), tool.id).toEqual(
        expect.arrayContaining(["name", "flow_path"])
      );
      expect(schema.required ?? [], tool.id).not.toContain("name");
      expect(schema.required ?? [], tool.id).not.toContain("flow_path");
    }
  });

  it("names the parameter it needs when no flow source is present", async () => {
    await expect(
      prereqRegistry().invokeTool("flow-read-prerequisite", { project_root: tmpDir })
    ).rejects.toThrow(/needs the flow's name in `name`.*\.argent\/flows\/<name>\.yaml/s);
  });

  it("anchors the exactly-one-source rule at the ROOT, not on flow_path", async () => {
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
    expect(message).not.toContain("needs the flow's name");
  });
});

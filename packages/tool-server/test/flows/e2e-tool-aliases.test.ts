import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { FILE_INPUT_MARKER, Registry, TOOL_ID_ALIASES } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRegistry } from "../../src/utils/setup-registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { parseFlow } from "../../src/tools/flows/flow-utils";

const ALIASES = Object.entries(TOOL_ID_ALIASES);

/** A registry with the seven e2e tools, as setup-registry registers them. */
function e2eRegistry(): Registry {
  const registry = new Registry();
  registry.registerTool(flowStartRecordingTool);
  registry.registerTool(createFlowAddStepTool(registry));
  registry.registerTool(flowInsertEchoTool);
  registry.registerTool(flowAddScriptTool);
  registry.registerTool(flowFinishRecordingTool);
  registry.registerTool(flowReadPrerequisiteTool);
  registry.registerTool(createRunFlowTool(registry));
  return registry;
}

let tmpDir: string;
let flowsDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "e2e-tool-aliases-")));
  flowsDir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFlow(name: string, yaml: string): Promise<string> {
  const file = path.join(flowsDir, `${name}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

/** A run report without its timing, which differs between two runs. */
function runShape(result: FlowRunResult) {
  return {
    ok: result.ok,
    flow: result.flow,
    steps: result.steps.map((s) => [s.kind, s.status, s.tool]),
  };
}

describe("the former flow-* tool ids", () => {
  it("are the aliases the tools declare, each resolving to its e2e-* tool", () => {
    const registry = createRegistry();
    const declared = registry
      .getSnapshot()
      .tools.flatMap((id) => (registry.getTool(id)!.aliases ?? []).map((alias) => [alias, id]));

    expect(Object.fromEntries(declared)).toEqual(TOOL_ID_ALIASES);
    for (const [alias, id] of ALIASES) {
      expect(registry.getTool(alias), alias).toBe(registry.getTool(id));
      expect(registry.getSnapshot().tools).not.toContain(alias);
    }
  });

  it("are listed by GET /tools for clients that call them, and hidden from MCP", async () => {
    const registry = createRegistry();
    const { app } = createHttpApp(registry);

    const res = await request(app).get("/tools");
    const tools = res.body.tools as {
      name: string;
      hideFromMcp?: boolean;
      aliasOf?: string;
      inputSchema: unknown;
      fileInputs?: unknown;
    }[];
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const [alias, id] of ALIASES) {
      const entry = byName.get(alias)!;
      const current = byName.get(id)!;
      expect(entry).toMatchObject({ aliasOf: id, hideFromMcp: true });
      expect(entry.inputSchema).toEqual(current.inputSchema);
      expect(entry.fileInputs).toEqual(current.fileInputs);
      expect(current.aliasOf).toBeUndefined();
    }
    // The MCP adapter lists every entry not marked hideFromMcp.
    const mcpNames = tools.filter((t) => !t.hideFromMcp).map((t) => t.name);
    for (const [alias, id] of ALIASES) {
      expect(mcpNames).not.toContain(alias);
      expect(mcpNames).toContain(id);
    }
    expect(tools.filter((t) => t.aliasOf === undefined)).toHaveLength(
      registry.getSnapshot().tools.length
    );
  });

  it("run the same flow with the same result through invokeTool and POST /tools", async () => {
    const flowFile = await writeFlow("demo", "steps:\n  - echo: hi\n  - echo: there\n");
    const registry = e2eRegistry();
    const { app } = createHttpApp(registry);
    const args = { name: "demo", project_root: tmpDir };

    const invoked = await Promise.all(
      ["flow-execute", "e2e-execute"].map(async (id) =>
        runShape((await registry.invokeTool(id, args)) as FlowRunResult)
      )
    );
    const posted = await Promise.all(
      ["flow-execute", "e2e-execute"].map(async (id) => {
        const res = await request(app)
          .post(`/tools/${id}`)
          .send({ ...args, flow_file: { [FILE_INPUT_MARKER]: true, path: flowFile } });
        expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
        return runShape(res.body.data as FlowRunResult);
      })
    );

    expect(invoked[0]).toMatchObject({ ok: true, flow: "demo" });
    expect(invoked[1]).toEqual(invoked[0]);
    expect(posted).toEqual([invoked[0], invoked[0]]);
  });

  it("answer the same for flow-read-prerequisite and e2e-read-prerequisite", async () => {
    await writeFlow("frag", 'executionPrerequisite: "on the form"\nsteps:\n  - echo: hi\n');
    const registry = e2eRegistry();
    const args = { name: "frag", project_root: tmpDir };

    const byAlias = await registry.invokeTool("flow-read-prerequisite", args);
    const byId = await registry.invokeTool("e2e-read-prerequisite", args);

    expect(byAlias).toEqual(byId);
  });

  it("log the HTTP failure of an alias call under the current id, with alias_used", async () => {
    const registry = e2eRegistry();
    const recordFailure = vi.fn();
    const { app } = createHttpApp(registry, { recordFailure });

    await request(app).post("/tools/flow-execute").send({ name: 5 });

    expect(recordFailure).toHaveBeenCalledWith(
      "e2e-execute",
      expect.objectContaining({ alias_used: true }),
      expect.anything(),
      expect.any(Number)
    );
  });
});

describe("recording across the old and new tool ids", () => {
  const key = () => ({ name: "mixed", project_root: tmpDir });

  for (const [start, echo, finish] of [
    ["flow-start-recording", "e2e-add-echo", "e2e-finish-recording"],
    ["e2e-start-recording", "flow-add-echo", "flow-finish-recording"],
  ]) {
    it(`starts with ${start} and finishes with ${finish}`, async () => {
      const registry = e2eRegistry();

      await registry.invokeTool(start!, { ...key(), executionPrerequisite: "on the form" });
      await registry.invokeTool(echo!, { ...key(), message: "hello" });
      const finished = (await registry.invokeTool(finish!, key())) as { steps: number };

      expect(finished.steps).toBe(1);
      const saved = parseFlow(
        await fs.readFile(path.join(tmpDir, ".argent", "e2e", "mixed.yaml"), "utf8")
      );
      expect(saved.steps).toEqual([{ kind: "echo", message: "hello" }]);
    });
  }
});

describe("a nested run named by either id", () => {
  it("runs a `tool: flow-execute` step and a `tool: e2e-execute` step alike", async () => {
    await writeFlow("child", "steps:\n  - echo: from the child\n");
    const nest = (tool: string) =>
      `  - tool: ${tool}\n    args: { name: child, project_root: ${JSON.stringify(tmpDir)} }\n`;
    await writeFlow("parent", `steps:\n${nest("flow-execute")}${nest("e2e-execute")}`);
    const registry = e2eRegistry();
    // A nested run takes a device, so the parent resolves one.
    registry.registerTool({
      id: "list-devices",
      services: () => ({}),
      execute: async () => ({
        devices: [
          { platform: "ios", udid: "00000000-0000-0000-0000-0000000000ab", state: "Booted" },
        ],
      }),
    });

    const result = (await registry.invokeTool("e2e-execute", {
      name: "parent",
      project_root: tmpDir,
    })) as FlowRunResult;

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.tool, s.status])).toEqual([
      ["flow-execute", "pass"],
      ["e2e-execute", "pass"],
    ]);
    const nested = result.steps.map((s) => runShape(s.result as FlowRunResult));
    expect(nested[0]).toMatchObject({ ok: true, flow: "child" });
    expect(nested[1]).toEqual(nested[0]);
  });

  it("is recorded under the e2e-execute id when the call used flow-execute", async () => {
    // A flow in another project is no sibling of the recording, so the
    // recorder keeps the call as a raw `tool:` step.
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "e2e-aliases-other-")));
    try {
      await fs.mkdir(path.join(other, ".argent", "flows"), { recursive: true });
      await fs.writeFile(
        path.join(other, ".argent", "flows", "elsewhere.yaml"),
        "steps:\n  - echo: hi\n"
      );
      const registry = e2eRegistry();
      await registry.invokeTool("e2e-start-recording", {
        name: "wrapper",
        project_root: tmpDir,
        executionPrerequisite: "anywhere",
      });

      await registry.invokeTool("e2e-add-step", {
        name: "wrapper",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: other }),
      });
      await registry.invokeTool("e2e-finish-recording", { name: "wrapper", project_root: tmpDir });

      const yaml = await fs.readFile(path.join(tmpDir, ".argent", "e2e", "wrapper.yaml"), "utf8");
      expect(parseFlow(yaml).steps).toEqual([
        { kind: "tool", name: "e2e-execute", args: { name: "elsewhere", project_root: other } },
      ]);
      expect(yaml).not.toContain("flow-execute");
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe("a nested run over a link, from the real argent client", () => {
  const clientSrc = path.resolve(__dirname, "../../../argent-tools-client/src/tools-client.ts");

  for (const tool of ["flow-execute", "e2e-execute"]) {
    it(`sends the flow a \`tool: ${tool}\` step names, and runs it`, async () => {
      await writeFlow("child", "steps:\n  - echo: from the child\n");
      const parent = await writeFlow(
        "parent",
        `steps:\n  - tool: ${tool}\n    args: { name: child, project_root: ${JSON.stringify(tmpDir)} }\n`
      );
      const registry = e2eRegistry();
      registry.registerTool({
        id: "list-devices",
        services: () => ({}),
        execute: async () => ({ devices: [] }),
      });
      const handle = createHttpApp(registry);
      const server = handle.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      try {
        const { createToolsClient } = (await import(clientSrc)) as {
          createToolsClient(options: object): {
            callTool(name: string, args: unknown): Promise<{ data: unknown }>;
          };
        };
        let members: { role: string; path: string }[] = [];
        const client = createToolsClient({
          baseUrl: async () => ({ url: `http://127.0.0.1:${port}`, token: "", remote: true }),
          fetchImpl: async (target: string, init: RequestInit) => {
            if (target.endsWith("/tools/flow-execute")) {
              members = JSON.parse(String(init.body)).flow_path.members;
            }
            return fetch(target, init);
          },
        });

        // The CLI still calls the tool by its former id.
        const { data } = await client.callTool("flow-execute", {
          flow_path: parent,
          project_root: tmpDir,
          device: "00000000-0000-0000-0000-0000000000ab",
        });

        expect(members.map((m) => [m.role, path.basename(m.path)])).toEqual([
          ["flow", "child.yaml"],
        ]);
        const run = data as FlowRunResult;
        expect(run.steps.map((s) => [s.tool, s.status])).toEqual([[tool, "pass"]]);
      } finally {
        server.close();
        handle.dispose();
      }
    });
  }
});

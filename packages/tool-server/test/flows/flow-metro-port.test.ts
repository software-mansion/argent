import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { FAILURE_CODES, FailureError, Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";
import { toolTakesMetroPort } from "../../src/tools/flows/flow-device";
import { metroPortField } from "../../src/utils/debugger/metro-port";
import { createRegistry } from "../../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "../helpers/catalog";

/**
 * A run's `metroPort` replaces the `port` of every step whose tool takes a Metro
 * port, also one the file wrote, and only of those tools: `boot-device`'s
 * `port` is an emulator console port. Without it each step keeps its own port.
 * A nested `e2e-execute` inherits the run's port unless the step names its own.
 *
 * The fake tools declare no device key; only the nested runs resolve a device.
 */

let root: string;
/** Every call a fake tool got, in order. */
let calls: { tool: string; args: Record<string, unknown> }[];

const e2e = (file: string) => path.join(root, ".argent", "e2e", file);

function registry(behaviour: { metroDown?: boolean } = {}): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  r.registerTool(createFlowAddStepTool(r) as never);
  // A nested run takes a device, so a test with one resolves it.
  r.registerTool({
    id: "list-devices",
    services: () => ({}),
    execute: async () => ({
      devices: [{ platform: "ios", udid: "00000000-0000-0000-0000-0000000000ab", state: "Booted" }],
    }),
  } as never);
  const record = (tool: string) => async (_s: unknown, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (behaviour.metroDown && (tool === "metro-tool" || tool === "console-port-tool")) {
      throw new FailureError(`Metro at port ${args.port ?? 8081} is not running`, {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
        failure_stage: "test",
        failure_area: "tool_server",
        error_kind: "network",
      });
    }
    return { ok: true };
  };
  r.registerTool({
    id: "metro-tool",
    description: "takes a Metro port",
    zodSchema: z.object({ port: metroPortField, label: z.string().optional() }),
    services: () => ({}),
    execute: record("metro-tool"),
  } as never);
  r.registerTool({
    id: "reworded-metro-tool",
    description: "takes a Metro port with its own wording",
    zodSchema: z.object({ port: metroPortField.describe("Metro port to exempt.") }).strict(),
    services: () => ({}),
    execute: record("reworded-metro-tool"),
  } as never);
  r.registerTool({
    id: "console-port-tool",
    description: "takes a port that is not Metro's",
    zodSchema: z.object({ port: z.number().int().optional() }),
    services: () => ({}),
    execute: record("console-port-tool"),
  } as never);
  r.registerTool({
    id: "no-port-tool",
    description: "takes no port",
    zodSchema: z.object({ label: z.string().optional() }).strict(),
    services: () => ({}),
    execute: record("no-port-tool"),
  } as never);
  // The name toolResultVerdict reads a not_connected result from.
  r.registerTool({
    id: "debugger-status",
    description: "reports Metro down",
    zodSchema: z.object({ port: metroPortField }),
    services: () => ({}),
    execute: async (_s: unknown, args: Record<string, unknown>) => {
      calls.push({ tool: "debugger-status", args });
      return {
        status: "not_connected",
        connected: false,
        port: args.port ?? 8081,
        reason: "metro_not_running",
        detail: `Metro at port ${args.port ?? 8081} is not running.`,
        guidance: "Start Metro.",
      };
    },
  } as never);
  return r;
}

async function writeTest(name: string, yaml: string): Promise<void> {
  await fs.writeFile(e2e(`${name}.yaml`), yaml);
}

async function run(r: Registry, name: string, extra: Record<string, unknown> = {}) {
  const result = await r.invokeTool<FlowRunResult>("e2e-execute", {
    name,
    project_root: root,
    prerequisiteAcknowledged: true,
    ...extra,
  });
  return result;
}

const portsOf = (tool: string) =>
  calls.filter((c) => c.tool === tool).map((c) => ("port" in c.args ? c.args.port : "absent"));

beforeEach(async () => {
  __resetRecordingsForTesting();
  calls = [];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-metro-port-")));
  await fs.mkdir(e2e(""), { recursive: true });
  await writeTest(
    "steps",
    `steps:
  - tool: metro-tool
    args: { port: 8096, label: written }
  - tool: metro-tool
    args: { label: bare }
  - tool: reworded-metro-tool
  - tool: console-port-tool
    args: { port: 5556 }
  - tool: console-port-tool
  - tool: no-port-tool
`
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a run with no metroPort", () => {
  it("keeps each step's own port and adds none", async () => {
    const result = await run(registry(), "steps");
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8096, "absent"]);
    expect(portsOf("reworded-metro-tool")).toEqual(["absent"]);
    expect(portsOf("console-port-tool")).toEqual([5556, "absent"]);
    expect(portsOf("no-port-tool")).toEqual(["absent"]);
  });
});

describe("a run with metroPort", () => {
  it("replaces every Metro port, also one the file wrote, and touches no other port", async () => {
    const result = await run(registry(), "steps", { metroPort: 8097 });
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8097, 8097]);
    // A reworded metroPortField is still a Metro port, and a .strict() schema
    // takes the bound port.
    expect(portsOf("reworded-metro-tool")).toEqual([8097]);
    // Not a Metro port: boot-device's emulator console port is this shape.
    expect(portsOf("console-port-tool")).toEqual([5556, "absent"]);
    // A .strict() tool without `port` would refuse an injected one.
    expect(portsOf("no-port-tool")).toEqual(["absent"]);
    // The report shows the port each step used.
    const reported = result.steps.filter((s) => s.tool === "metro-tool").map((s) => s.args);
    expect(reported).toEqual([
      { port: 8097, label: "written" },
      { port: 8097, label: "bare" },
    ]);
  });

  it("takes a port as a string, as the tool-server's HTTP and MCP callers may send it", async () => {
    const result = await run(registry(), "steps", { metroPort: "8098" });
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8098, 8098]);
  });

  it.each([0, 65536, 80.5])("refuses metroPort %s before any step runs", async (metroPort) => {
    await expect(run(registry(), "steps", { metroPort })).rejects.toThrow(/metroPort/);
    expect(calls).toEqual([]);
  });

  it("reaches run: fragments and shutdown: steps", async () => {
    await writeTest("frag", `steps:\n  - tool: metro-tool\n    args: { port: 8096 }\n`);
    await writeTest(
      "parent",
      `steps:
  - run: frag.yaml
shutdown:
  - tool: metro-tool
    args: { label: teardown }
`
    );
    const result = await run(registry(), "parent", { metroPort: 8097 });
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8097, 8097]);
  });
});

describe("a nested tool: e2e-execute", () => {
  beforeEach(async () => {
    await writeTest("inner", `steps:\n  - tool: metro-tool\n`);
    const nest = (extra: string) =>
      `  - tool: e2e-execute\n    args: { name: inner, project_root: ${JSON.stringify(root)}${extra} }\n`;
    await writeTest("outer", `steps:\n${nest("")}${nest(", metroPort: 8099")}`);
  });

  it("inherits the run's port unless the step names its own", async () => {
    const result = await run(registry(), "outer", { metroPort: 8097 });
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8097, 8099]);
    // Each nested report shows the port its step used. The outer step's own
    // `args` stay as written: the port is added at dispatch, like updateBaselines.
    const nestedPorts = result.steps.map(
      (s) => ((s.result as FlowRunResult).steps[0]!.args as { port?: number }).port
    );
    expect(nestedPorts).toEqual([8097, 8099]);
  });

  it("keeps the step's own port when the run has none", async () => {
    const result = await run(registry(), "outer");
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual(["absent", 8099]);
  });
});

describe("a run: step with its own metroPort", () => {
  beforeEach(async () => {
    await writeTest("inner", `steps:\n  - tool: metro-tool\n`);
    await writeTest(
      "frag",
      `steps:
  - tool: metro-tool
    args: { port: 8096 }
  - tool: e2e-execute
    args: { name: inner, project_root: ${JSON.stringify(root)} }
shutdown:
  - tool: metro-tool
    args: { label: frag-teardown }
`
    );
    await writeTest(
      "parent",
      `steps:
  - run: { path: frag.yaml, metroPort: 8099 }
  - tool: metro-tool
    args: { label: after }
`
    );
  });

  it("gives the fragment, its nested runs and its shutdown that port, over the run's", async () => {
    const result = await run(registry(), "parent", { metroPort: 8097 });
    expect(result.ok).toBe(true);
    const order = calls
      .filter((c) => c.tool === "metro-tool")
      .map((c) => [c.args.label, c.args.port]);
    // The fragment's step, its nested run, the parent's next step, then the
    // fragment's shutdown at the end of the run.
    expect(order).toEqual([
      [undefined, 8099],
      [undefined, 8099],
      ["after", 8097],
      ["frag-teardown", 8099],
    ]);
  });

  it("gives the fragment that port in a run without one, and nothing to the rest", async () => {
    const result = await run(registry(), "parent");
    expect(result.ok).toBe(true);
    expect(portsOf("metro-tool")).toEqual([8099, 8099, "absent", 8099]);
  });

  it("is written back as the map, and a plain path stays a plain path", () => {
    const text =
      "steps:\n  - run: { path: frag.yaml, metroPort: 8099 }\n  - run: { path: other.yaml }\n";
    const yaml = serializeFlow(parseFlow(text));
    expect(parseFlow(yaml).steps).toEqual([
      { kind: "run", flow: "frag.yaml", metroPort: 8099 },
      { kind: "run", flow: "other.yaml" },
    ]);
    expect(yaml).toContain("- run: other.yaml");
  });

  it.each([
    ["metroPort: 0", /metroPort/],
    ["metroPort: 65536", /metroPort/],
    ['metroPort: "8096"', /metroPort/],
    ["metroPort: 8096, port: 1", /`port`/],
  ])("refuses run: { path: frag.yaml, %s }", (extra, message) => {
    expect(() => parseFlow(`steps:\n  - run: { path: frag.yaml, ${extra} }\n`)).toThrow(message);
  });

  it("refuses a run: map without a path", () => {
    expect(() => parseFlow("steps:\n  - run: { metroPort: 8096 }\n")).toThrow(/needs a `path`/);
  });

  it("is what the recorder writes for a live e2e-execute call with a metroPort", async () => {
    const r = registry();
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const add = (args: Record<string, unknown>) =>
      r.invokeTool("e2e-add-step", {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ project_root: root, prerequisiteAcknowledged: true, ...args }),
      });
    await add({ name: "inner", metroPort: "8096" });
    await add({ name: "inner" });
    // The live call ran its fragment on that port.
    expect(portsOf("metro-tool")).toEqual([8096, "absent"]);
    const saved = parseFlow(await fs.readFile(e2e("rec.yaml"), "utf8"));
    expect(saved.steps).toEqual([
      { kind: "run", flow: "inner.yaml", metroPort: 8096 },
      { kind: "run", flow: "inner.yaml" },
    ]);
  });
});

describe("a step that finds no Metro", () => {
  const HINT = "argent e2e run --metro-port <port>";

  it("names --metro-port in a run without metroPort, for a thrown failure", async () => {
    await writeTest("down", `steps:\n  - tool: metro-tool\n`);
    const result = await run(registry({ metroDown: true }), "down");
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.status).toBe("error");
    expect(result.steps[0]!.reason).toContain("Metro at port 8081 is not running");
    expect(result.steps[0]!.reason).toContain(HINT);
  });

  it("names --metro-port for a not_connected result", async () => {
    await writeTest("down", `steps:\n  - tool: debugger-status\n    args: { port: 8096 }\n`);
    const result = await run(registry(), "down");
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toContain("(metro_not_running)");
    expect(result.steps[0]!.reason).toContain(HINT);
  });

  it("names it only for a tool whose port --metro-port sets", async () => {
    await writeTest("down", `steps:\n  - tool: console-port-tool\n`);
    const result = await run(registry({ metroDown: true }), "down");
    expect(result.steps[0]!.reason).toContain("is not running");
    expect(result.steps[0]!.reason).not.toContain(HINT);
  });

  it("gives no hint for a not_connected result when the run named the port", async () => {
    await writeTest("down", `steps:\n  - tool: debugger-status\n`);
    const result = await run(registry(), "down", { metroPort: 8097 });
    expect(result.steps[0]!.reason).toContain("(metro_not_running)");
    expect(result.steps[0]!.reason).not.toContain(HINT);
  });

  it("gives no hint when the run already named the port", async () => {
    await writeTest("down", `steps:\n  - tool: metro-tool\n`);
    const result = await run(registry({ metroDown: true }), "down", { metroPort: 8097 });
    expect(result.steps[0]!.reason).toContain("Metro at port 8097 is not running");
    expect(result.steps[0]!.reason).not.toContain(HINT);
  });
});

describe("which real tools take a Metro port", () => {
  const definitions = definitionsById(createRegistry());
  const registryOf = { getTool: (id: string) => definitions.get(id) } as unknown as Registry;
  const withPort = [...definitions]
    .map(([id, def]) => {
      const props = advertisedSchema(def)?.properties as
        Record<string, { description?: string }> | undefined;
      return { id, description: props?.port?.description };
    })
    .filter((t) => t.description !== undefined);

  it("binds boot-device's emulator console port never, and stop-metro's port always", () => {
    expect(toolTakesMetroPort(registryOf, "boot-device")).toBe(false);
    expect(toolTakesMetroPort(registryOf, "stop-metro")).toBe(true);
    expect(toolTakesMetroPort(registryOf, "debugger-status")).toBe(true);
  });

  // A new tool that declares a Metro port with a field of its own would
  // otherwise keep its recorded port when the run names another.
  it("binds every port whose description says Metro, and no other", () => {
    expect(withPort.length).toBeGreaterThan(20);
    for (const { id, description } of withPort) {
      expect({ id, bound: toolTakesMetroPort(registryOf, id) }).toEqual({
        id,
        bound: /Metro/.test(description!),
      });
    }
  });
});

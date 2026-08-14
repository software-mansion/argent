import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ArtifactStore, Registry, type ToolContext } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-external-tools-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
  const flowsDir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(
    path.join(flowsDir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
}

async function writeRegistry(name: string, tools: string): Promise<string> {
  const registryPath = path.join(tmpDir, `${name}.ts`);
  await fs.writeFile(registryPath, `export default { version: 1, tools: [${tools}] };\n`, "utf8");
  return registryPath;
}

function registryContext(registryPath: string): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      tool_registry_path: {
        clientPath: registryPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      },
    },
  };
}

function asRun(result: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

async function runWithRegistry(
  registry: Registry,
  flowName: string,
  registryPath: string,
  device?: string
): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute(
    {},
    {
      name: flowName,
      project_root: tmpDir,
      tool_registry_path: registryPath,
      ...(device ? { device } : {}),
    },
    registryContext(registryPath)
  );
  return asRun(result);
}

describe("flow-execute external tool registries", () => {
  it("invokes an external tool and keeps its structured result in the report", async () => {
    const registryPath = await writeRegistry(
      "structured-registry",
      `{
        id: "external.structured",
        description: "Return a structured result",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        },
        async execute(params: { message: string }) {
          return {
            echoed: params.message,
            nested: { values: [1, 2, 3], ok: true }
          };
        }
      }`
    );
    await writeFlow("structured", [
      { kind: "tool", name: "external.structured", args: { message: "hello" } },
    ]);
    const registry = new Registry();

    const result = await runWithRegistry(registry, "structured", registryPath);

    expect(result).toMatchObject({ ok: true, device: "", passed: 1, errored: 0 });
    expect(result.steps).toMatchObject([
      {
        kind: "tool",
        status: "pass",
        tool: "external.structured",
        args: { message: "hello" },
        result: {
          echoed: "hello",
          nested: { values: [1, 2, 3], ok: true },
        },
      },
    ]);
    expect(registry.getTool("external.structured")).toBeUndefined();
  });

  it("reports a thrown external error and skips every later step", async () => {
    const registryPath = await writeRegistry(
      "failure-registry",
      `{
        id: "external.fail",
        description: "Fail deliberately",
        inputSchema: { type: "object" },
        async execute() { throw new Error("external boom"); }
      }, {
        id: "external.after",
        description: "Must not run after a failure",
        inputSchema: { type: "object" },
        async execute() { return { ran: true }; }
      }`
    );
    await writeFlow("external-error", [
      { kind: "tool", name: "external.fail", args: {} },
      { kind: "tool", name: "external.after", args: {} },
    ]);

    const result = await runWithRegistry(new Registry(), "external-error", registryPath);

    expect(result.ok).toBe(false);
    expect(result.errored).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "external.fail",
      reason: expect.stringContaining("external boom"),
    });
    expect(result.steps[1]).toMatchObject({ kind: "tool", status: "skip" });
    expect(result.steps[1]).not.toHaveProperty("result");
  });

  it("continues to resolve and invoke built-in tools when a registry is present", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "built.echo",
      description: "Built-in echo",
      inputSchema: { type: "object" },
      services: () => ({}),
      async execute(_services, params) {
        return { source: "built-in", params };
      },
    });
    const registryPath = await writeRegistry(
      "coexist-registry",
      `{
        id: "external.unused",
        description: "Unused external tool",
        inputSchema: { type: "object" },
        async execute() { return { source: "external" }; }
      }`
    );
    await writeFlow("built-in", [{ kind: "tool", name: "built.echo", args: { value: 7 } }]);

    const result = await runWithRegistry(registry, "built-in", registryPath);

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "built.echo",
      result: { source: "built-in", params: { value: 7 } },
    });
    expect(registry.getSnapshot().tools).toEqual(["built.echo"]);
  });

  it("shares the invocation-scoped external tools with run fragments", async () => {
    const registryPath = await writeRegistry(
      "fragment-registry",
      `{
        id: "external.fragment",
        description: "Run from a fragment",
        inputSchema: { type: "object" },
        async execute(params: unknown) { return { from: "fragment", params }; }
      }`
    );
    await writeFlow("fragment", [
      { kind: "tool", name: "external.fragment", args: { value: "nested" } },
    ]);
    await writeFlow("root", [{ kind: "run", flow: "fragment.yaml" }]);

    const result = await runWithRegistry(new Registry(), "root", registryPath, DEVICE);

    expect(result.ok).toBe(true);
    expect(result.device).toBe(DEVICE);
    expect(result.steps).toMatchObject([
      { kind: "run", status: "pass", flow: "fragment", target: "fragment.yaml" },
      {
        kind: "tool",
        status: "pass",
        tool: "external.fragment",
        flow: "fragment",
        depth: 1,
        result: { from: "fragment", params: { value: "nested" } },
      },
    ]);
  });

  it("leaves ordinary no-registry flow behavior unchanged", async () => {
    await writeFlow("ordinary", [
      { kind: "echo", message: "still ordinary" },
      { kind: "wait", ms: 0 },
    ]);

    const result = asRun(
      await createRunFlowTool(new Registry()).execute(
        {},
        { name: "ordinary", project_root: tmpDir }
      )
    );

    expect(result).toMatchObject({
      flow: "ordinary",
      device: "",
      ok: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
    });
    expect(result.steps).toMatchObject([
      { kind: "echo", status: "pass", message: "still ordinary" },
      { kind: "wait", status: "pass" },
    ]);
  });

  it("binds the run device when an external schema declares udid", async () => {
    const registryPath = await writeRegistry(
      "device-registry",
      `{
        id: "external.device",
        description: "Report the bound device",
        inputSchema: {
          type: "object",
          properties: {
            udid: { type: "string" },
            label: { type: "string" }
          },
          required: ["udid", "label"],
          additionalProperties: false
        },
        async execute(params: { udid: string; label: string }) {
          return { receivedUdid: params.udid, label: params.label };
        }
      }`
    );
    await writeFlow("device-bound", [
      {
        kind: "tool",
        name: "external.device",
        args: { udid: "stale-recorded-device", label: "bound" },
      },
    ]);

    const result = await runWithRegistry(new Registry(), "device-bound", registryPath, DEVICE);

    expect(result.ok).toBe(true);
    expect(result.device).toBe(DEVICE);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "external.device",
      args: { udid: DEVICE, label: "bound" },
      result: { receivedUdid: DEVICE, label: "bound" },
    });
  });

  it("isolates two concurrent flow invocations with different registry definitions", async () => {
    const [leftRegistryPath, rightRegistryPath] = await Promise.all([
      writeRegistry(
        "left-registry",
        `{
          id: "external.shared",
          description: "Left implementation",
          inputSchema: { type: "object" },
          async execute() { return { implementation: "left" }; }
        }`
      ),
      writeRegistry(
        "right-registry",
        `{
          id: "external.shared",
          description: "Right implementation",
          inputSchema: { type: "object" },
          async execute() { return { implementation: "right" }; }
        }`
      ),
    ]);
    await Promise.all([
      writeFlow("left", [{ kind: "tool", name: "external.shared", args: {} }]),
      writeFlow("right", [{ kind: "tool", name: "external.shared", args: {} }]),
    ]);
    const registry = new Registry();
    const runFlow = createRunFlowTool(registry);

    const [left, right] = await Promise.all([
      runFlow.execute(
        {},
        {
          name: "left",
          project_root: tmpDir,
          tool_registry_path: leftRegistryPath,
        },
        registryContext(leftRegistryPath)
      ),
      runFlow.execute(
        {},
        {
          name: "right",
          project_root: tmpDir,
          tool_registry_path: rightRegistryPath,
        },
        registryContext(rightRegistryPath)
      ),
    ]);

    expect(asRun(left).steps[0]?.result).toEqual({ implementation: "left" });
    expect(asRun(right).steps[0]?.result).toEqual({ implementation: "right" });
    expect(registry.getTool("external.shared")).toBeUndefined();
    expect(registry.getSnapshot().tools).toEqual([]);
  });
});

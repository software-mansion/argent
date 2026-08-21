import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FAILURE_CODES, Registry, ToolExecutionError, getFailureSignal } from "@argent/registry";

import { loadExternalToolRegistry } from "../src/utils/external-tool-registry";

let tmpDir: string;
let nextRegistry = 0;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-tool-registry-test-"));
  nextRegistry = 0;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRegistry(source: string, name?: string): Promise<string> {
  const filePath = path.join(tmpDir, name ?? `registry-${nextRegistry++}.ts`);
  await fs.writeFile(filePath, source, "utf8");
  return filePath;
}

function registrySource(
  options: {
    id?: string;
    inputSchema?: string;
    execute?: string;
    description?: string;
  } = {}
): string {
  const id = options.id ?? "external.echo";
  const inputSchema = options.inputSchema ?? `{ type: "object" }`;
  const execute = options.execute ?? `async execute(params: unknown) { return params; }`;
  const description = options.description ?? "External test tool";
  return `
    export default {
      version: 1,
      tools: [{
        id: ${JSON.stringify(id)},
        description: ${JSON.stringify(description)},
        inputSchema: ${inputSchema},
        ${execute}
      }]
    };
  `;
}

async function expectInvalidRegistry(source: string, message: RegExp): Promise<void> {
  const filePath = await writeRegistry(source);
  try {
    await loadExternalToolRegistry(filePath, new Registry());
    throw new Error("expected registry loading to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.FLOW_EXTERNAL_REGISTRY_INVALID);
  }
}

describe("loadExternalToolRegistry", () => {
  it("rejects a TypeScript module that cannot be loaded", async () => {
    const registryPath = await writeRegistry(`export default { version: 1, tools: [`);

    try {
      await loadExternalToolRegistry(registryPath, new Registry());
      throw new Error("expected registry loading to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Could not load external tool registry");
      expect(getFailureSignal(error)?.error_code).toBe(
        FAILURE_CODES.FLOW_EXTERNAL_REGISTRY_LOAD_FAILED
      );
    }
  });

  it.each<[string, string, RegExp]>([
    ["a primitive default export", `export default 42;`, /module must export an object|expected 1/],
    ["a missing tools export", `export const version = 1;`, /"tools" must be an array/],
    [
      "an unsupported version",
      `export default { version: 2, tools: [] };`,
      /unsupported version 2/,
    ],
    [
      "a non-array tools export",
      `export default { version: 1, tools: {} };`,
      /"tools" must be an array/,
    ],
  ])("rejects %s", async (_label, source, message) => {
    await expectInvalidRegistry(source, message);
  });

  it.each<[string, string, RegExp]>([
    ["a non-object tool", `export default { version: 1, tools: [null] };`, /must be an object/],
    [
      "a missing id",
      `export default {
        version: 1,
        tools: [{
          description: "Missing id",
          inputSchema: { type: "object" },
          async execute(params: unknown) { return params; }
        }]
      };`,
      /\.id must match/,
    ],
    ["an invalid id", registrySource({ id: "external tool" }), /\.id must match/],
    [
      "duplicate ids",
      `
        const tool = {
          id: "external.duplicate",
          description: "Duplicate",
          inputSchema: { type: "object" },
          async execute(params: unknown) { return params; }
        };
        export default { version: 1, tools: [tool, { ...tool }] };
      `,
      /duplicate external tool id "external\.duplicate"/,
    ],
  ])("rejects %s", async (_label, source, message) => {
    await expectInvalidRegistry(source, message);
  });

  it("rejects an external id that collides with a built-in tool", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "built.in",
      description: "Built in",
      inputSchema: { type: "object" },
      services: () => ({}),
      async execute() {
        return "built-in";
      },
    });
    const registryPath = await writeRegistry(registrySource({ id: "built.in" }));

    await expect(loadExternalToolRegistry(registryPath, registry)).rejects.toThrow(
      /collides with a built-in tool/
    );
    expect(registry.getSnapshot().tools).toEqual(["built.in"]);
  });

  it("validates input with JSON Schema before calling execute", async () => {
    const registryPath = await writeRegistry(
      registrySource({
        inputSchema: `{
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        }`,
        execute: `async execute() { throw new Error("execute should not run"); }`,
      })
    );
    const tools = await loadExternalToolRegistry(registryPath, new Registry());

    try {
      await tools.invokeTool("external.echo", { message: 7 });
      throw new Error("expected invocation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect((error as Error).message).toContain("Invalid params for external tool");
      expect((error as Error).message).not.toContain("execute should not run");
      expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    }
  });

  it("returns a JSON-normalized copy of a serializable result", async () => {
    const registryPath = await writeRegistry(
      registrySource({
        execute: `async execute() {
          return {
            kept: "value",
            omitted: undefined,
            date: new Date("2025-01-02T03:04:05.000Z")
          };
        }`,
      })
    );
    const tools = await loadExternalToolRegistry(registryPath, new Registry());

    await expect(tools.invokeTool("external.echo", {})).resolves.toEqual({
      kept: "value",
      date: "2025-01-02T03:04:05.000Z",
    });
  });

  it("rejects a result that cannot be serialized as JSON", async () => {
    const registryPath = await writeRegistry(
      registrySource({ execute: `async execute() { return { value: 1n }; }` })
    );
    const tools = await loadExternalToolRegistry(registryPath, new Registry());

    try {
      await tools.invokeTool("external.echo", {});
      throw new Error("expected invocation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect((error as Error).message).toContain("not JSON-serializable");
      expect(getFailureSignal(error)?.error_code).toBe(
        FAILURE_CODES.FLOW_EXTERNAL_TOOL_RESULT_INVALID
      );
    }
  });

  it("passes the cancellation signal and tool invocation id to execute", async () => {
    const registryPath = await writeRegistry(
      registrySource({
        execute: `async execute(_params: unknown, context: {
          signal?: AbortSignal;
          toolInvocationId?: string;
        }) {
          return {
            aborted: context.signal?.aborted,
            toolInvocationId: context.toolInvocationId
          };
        }`,
      })
    );
    const tools = await loadExternalToolRegistry(registryPath, new Registry());
    const controller = new AbortController();
    controller.abort();

    await expect(
      tools.invokeTool(
        "external.echo",
        {},
        {
          signal: controller.signal,
          toolInvocationId: "external-invocation-42",
        }
      )
    ).resolves.toEqual({
      aborted: true,
      toolInvocationId: "external-invocation-42",
    });
  });

  it("reloads an edited module at the same path without stale cache state", async () => {
    const registryPath = await writeRegistry(
      registrySource({ execute: `async execute() { return { revision: 1 }; }` }),
      "mutable-registry.ts"
    );
    const registry = new Registry();
    const firstLoad = await loadExternalToolRegistry(registryPath, registry);
    await expect(firstLoad.invokeTool("external.echo", {})).resolves.toEqual({ revision: 1 });

    await fs.writeFile(
      registryPath,
      registrySource({ execute: `async execute() { return { revision: 2 }; }` }),
      "utf8"
    );
    const secondLoad = await loadExternalToolRegistry(registryPath, registry);

    await expect(secondLoad.invokeTool("external.echo", {})).resolves.toEqual({ revision: 2 });
    await expect(firstLoad.invokeTool("external.echo", {})).resolves.toEqual({ revision: 1 });
  });

  it("keeps concurrently loaded registries with the same external id isolated", async () => {
    const [leftPath, rightPath] = await Promise.all([
      writeRegistry(
        registrySource({ execute: `async execute() { return { registry: "left" }; }` })
      ),
      writeRegistry(
        registrySource({ execute: `async execute() { return { registry: "right" }; }` })
      ),
    ]);
    const registry = new Registry();
    const [left, right] = await Promise.all([
      loadExternalToolRegistry(leftPath, registry),
      loadExternalToolRegistry(rightPath, registry),
    ]);

    await expect(
      Promise.all([left.invokeTool("external.echo", {}), right.invokeTool("external.echo", {})])
    ).resolves.toEqual([{ registry: "left" }, { registry: "right" }]);
    expect(registry.getTool("external.echo")).toBeUndefined();
    expect(registry.getSnapshot().tools).toEqual([]);
  });

  it("delegates built-in lookups and invocation without mutating the Registry map", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "built.in",
      description: "Built in",
      inputSchema: { type: "object" },
      services: () => ({}),
      async execute(_services, params, context) {
        return {
          source: "built-in",
          params,
          toolInvocationId: context?.toolInvocationId,
        };
      },
    });
    const originalDefinition = registry.getTool("built.in");
    const registryPath = await writeRegistry(registrySource());
    const tools = await loadExternalToolRegistry(registryPath, registry);

    expect(tools.getTool("built.in")).toBe(originalDefinition);
    expect(tools.getTool("external.echo")?.id).toBe("external.echo");
    await expect(
      tools.invokeTool("built.in", { value: 7 }, { toolInvocationId: "built-in-17" })
    ).resolves.toEqual({
      source: "built-in",
      params: { value: 7 },
      toolInvocationId: "built-in-17",
    });

    expect(registry.getTool("external.echo")).toBeUndefined();
    expect(registry.getSnapshot().tools).toEqual(["built.in"]);
  });
});

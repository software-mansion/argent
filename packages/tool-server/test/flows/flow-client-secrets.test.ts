import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InvokeToolOptions, Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => ({
    tree: {
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "AXTextField",
          identifier: "pw",
          focused: true,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
          children: [],
        } as DescribeNode,
      ],
    },
    source: "native-devtools",
  })),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-client-secrets-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("the client's secrets in an e2e run", () => {
  it("reach the keyboard call of a type: step and of a tool: step", async () => {
    const keyboard: Array<InvokeToolOptions | undefined> = [];
    const registry = {
      invokeTool: vi.fn(async (id: string, _args: unknown, options?: InvokeToolOptions) => {
        if (id === "keyboard") keyboard.push(options);
        if (id === "list-devices") return { devices: [] };
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "type", into: { identifier: "pw" }, text: "{{secret:PW}}", submit: false },
          { kind: "tool", name: "keyboard", args: { text: "{{secret:PW}}" } },
        ],
      }),
      "utf8"
    );
    const clientSecrets = new Map([["PW", "from-client"]]);

    const result = (await createRunFlowTool(registry).execute(
      {},
      { name: "login", project_root: tmpDir, device: DEVICE },
      { clientSecrets } as never
    )) as FlowRunResult;

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass", "tool:pass"]);
    expect(keyboard.map((options) => options?.clientSecrets)).toEqual([
      clientSecrets,
      clientSecrets,
    ]);
  });
});

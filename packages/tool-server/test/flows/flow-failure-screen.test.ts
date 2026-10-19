import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-failure-screen-tests-${process.pid}`);

const SHOT = { id: "shot-1", kind: "screenshot", hostPath: "/tmp/shot-1.png" };

function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, "screen.yaml");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

const TAP = `  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

const AWAIT = `  - tool: await-ui-element
    args:
      udid: X
      condition: visible
      selector:
        text: Continue
`;

const TYPE_SECRET = `  - tool: keyboard
    args:
      udid: X
      text: "{{secret:PASSWORD}}"
`;

async function run(steps: string, awaitMet: boolean, shot: () => Promise<unknown>) {
  const flowFile = await writeFlow(`executionPrerequisite: ""\nsteps:\n${steps}`);
  const registry = makeRegistry(async (id) => {
    if (id === "screenshot") return shot();
    if (id === "await-ui-element") {
      return awaitMet ? { success: true, elapsed: 10 } : { success: false, elapsed: 5000 };
    }
    return { ok: true };
  });
  const result = (await createRunFlowTool(registry).execute(
    {},
    { name: "screen", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
  )) as FlowRunResult;
  const shots = vi.mocked(registry.invokeTool).mock.calls.filter(([id]) => id === "screenshot");
  return { result, shots };
}

describe("flow-execute screenshot of a failed step", () => {
  it("attaches the screen to the failed step", async () => {
    const { result, shots } = await run(TAP + AWAIT + TAP, false, async () => ({ image: SHOT }));

    expect(shots).toHaveLength(1);
    expect(shots[0][1]).toMatchObject({ udid: "X", scale: 1, includeImageInContext: false });
    const failed = result.steps[1];
    expect(failed.status).toBe("fail");
    expect(failed.artifacts).toEqual({ screen: SHOT });
    expect(result.steps[0].artifacts).toBeUndefined();
    expect(result.steps[2].artifacts).toBeUndefined();
  });

  it("takes no screenshot when every step passes", async () => {
    const { result, shots } = await run(TAP + AWAIT, true, async () => ({ image: SHOT }));

    expect(result.ok).toBe(true);
    expect(shots).toHaveLength(0);
  });

  it("takes no screenshot after a step typed a secret", async () => {
    const { result, shots } = await run(TYPE_SECRET + AWAIT, false, async () => ({ image: SHOT }));

    expect(result.steps[1].status).toBe("fail");
    expect(shots).toHaveLength(0);
    expect(result.steps[1].artifacts).toBeUndefined();
  });

  it("keeps the step's own failure when the screenshot throws", async () => {
    const { result, shots } = await run(AWAIT, false, async () => {
      throw new Error("device gone");
    });

    expect(shots).toHaveLength(1);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toMatch(/device gone/);
    expect(result.steps[0].artifacts).toBeUndefined();
  });
});

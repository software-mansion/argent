/**
 * End-to-end regression for the feature-flag-gate bypass (PR #271 FIX 1).
 *
 * `flow-execute` dispatches arbitrary tool ids through `registry.invokeTool`.
 * Before the fix, the `argent-lens` gate lived ONLY at the HTTP edge
 * (http.ts), so a flow could invoke a flag-gated tool (e.g. `propose_variant`)
 * even while the flag was OFF — the registry dispatch had no gate. This test
 * drives a REAL `Registry` (not the mock used elsewhere) so the gate it
 * exercises is the production one, and proves:
 *
 *   - flag OFF → the step errors with "not found" AND the gated tool's side
 *     effect never happens (store not mutated);
 *   - flag ON  → the same step runs and the side effect lands.
 *
 * Run `run_in_band`-style serially because it relies on a shared active project
 * root (the flow harness's module state), like the sibling flow tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Registry } from "@argent/registry";

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import {
  clearActiveProjectRoot,
  setActiveProjectRoot,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";

let tmpDir: string;

/**
 * Builds a real Registry whose flag check we control, with a flag-gated tool
 * whose `execute` flips `sideEffect.ran` — our observable "store mutation".
 */
function buildRegistry(flagEnabled: boolean): { registry: Registry; sideEffect: { ran: boolean } } {
  const sideEffect = { ran: false };
  const registry = new Registry({ isFlagEnabled: () => flagEnabled });
  registry.registerTool({
    id: "propose_variant",
    featureFlag: "argent-lens",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      sideEffect.ran = true;
      return { ok: true };
    },
  });
  return { registry, sideEffect };
}

async function writeFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "propose_variant", args: {} }],
    })
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-flag-gate-"));
  setActiveProjectRoot(tmpDir);
});

afterEach(async () => {
  clearActiveProjectRoot();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-execute honors the registry feature-flag gate", () => {
  it("flag OFF: the gated step errors (not found) and the tool's side effect never runs", async () => {
    const { registry, sideEffect } = buildRegistry(false);
    const runFlow = createRunFlowTool(registry);
    await writeFlow("gated-off");

    const result = await runFlow.execute(
      {},
      { name: "gated-off", project_root: tmpDir, device: "00000000-0000-0000-0000-0000000000ab" }
    );

    expect(result).toHaveProperty("steps");
    const steps = (
      result as { steps: Array<{ kind: string; status: string; tool?: string; reason?: string }> }
    ).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "tool", status: "error", tool: "propose_variant" });
    // "not found" surfaces because the disabled flag-gated tool is treated as
    // unregistered by the registry (mirrors the HTTP 404).
    expect(steps[0]!.reason).toMatch(/not found/i);
    // The bypass is closed: the gated tool's body never ran.
    expect(sideEffect.ran).toBe(false);
  });

  it("flag ON: the same gated step runs and the side effect lands", async () => {
    const { registry, sideEffect } = buildRegistry(true);
    const runFlow = createRunFlowTool(registry);
    await writeFlow("gated-on");

    const result = await runFlow.execute(
      {},
      { name: "gated-on", project_root: tmpDir, device: "00000000-0000-0000-0000-0000000000ab" }
    );

    const steps = (
      result as { steps: Array<{ kind: string; status: string; tool?: string; result?: unknown }> }
    ).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "propose_variant",
      result: { ok: true },
    });
    expect(steps[0]).not.toHaveProperty("reason");
    expect(sideEffect.ran).toBe(true);
  });
});

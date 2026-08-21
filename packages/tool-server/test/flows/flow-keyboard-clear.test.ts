import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { __resetRecordingsForTesting } from "../../src/tools/flows/flow-utils";

// `clear` is exercised at the tool level everywhere else. The flow path is where
// losing it is silent: a recorded `tool: keyboard` step rewritten as a `type:`
// directive — which the polish table orders and which accepts only
// `into`/`text`/`submit` — replays as a plain APPEND into the pre-filled field,
// and the flow still reports PASS. So the property worth pinning is the round
// trip: `clear` survives recording, and it survives replay.

const DEVICE = "emulator-5554";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

function mockRegistry(calls: Call[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      return { typed: "replacement", keys: 11, cleared: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

const flowPath = (name: string) => path.join(tmpDir, ".argent", "flows", `${name}.yaml`);

beforeEach(async () => {
  __resetRecordingsForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-kbclear-"));
});
afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("keyboard `clear` through record and replay", () => {
  it("declares the recorder long-running, since it inherits the step's worst case", () => {
    // `flow-add-step` dispatches an arbitrary tool by name, so its worst case is
    // the worst case of whatever it wraps — and `keyboard` budgets ~56s for a
    // `{ clear, text, key }` and declares the flag itself for that reason.
    // Without it here the MCP adapter applies its 30s fetch timeout to the
    // RECORDING of such a step and, on abort, re-POSTs the identical body up to
    // 4 more times. None of that work is cancellable, so each retry is a fresh
    // device action AND a fresh appended step.
    //
    // Measured against a real tool-server through the real MCP adapter,
    // recording one `await-ui-element` with `timeoutMs: 40000`: the call took
    // 153s, returned "This operation was aborted" — so the agent concludes
    // nothing was recorded — and left FIVE identical steps in the YAML, which
    // the replay then performs five times. With the flag: 40s, one step, no
    // error.
    expect(createFlowAddStepTool(mockRegistry([])).longRunning).toBe(true);
  });

  it("keeps `clear` in the recorded YAML", async () => {
    const calls: Call[] = [];
    const addStep = createFlowAddStepTool(mockRegistry(calls));

    await flowStartRecordingTool.execute({}, { name: "replace", project_root: tmpDir });
    await addStep.execute(
      {},
      {
        name: "replace",
        project_root: tmpDir,
        command: "keyboard",
        args: JSON.stringify({ udid: DEVICE, clear: true, text: "replacement" }),
      }
    );
    await flowFinishRecordingTool.execute({}, { name: "replace", project_root: tmpDir });

    const yaml = await fs.readFile(flowPath("replace"), "utf8");
    expect(yaml).toContain("tool: keyboard");
    expect(yaml).toContain("clear: true");
    // The device id is never stored — a recorded flow replays wherever it is
    // pointed — so its absence is what tells `clear` apart from a passthrough
    // of the whole argument object.
    expect(yaml).not.toContain(DEVICE);
  });

  it("replays the recorded step with `clear` still set", async () => {
    const recorded: Call[] = [];
    const addStep = createFlowAddStepTool(mockRegistry(recorded));

    await flowStartRecordingTool.execute({}, { name: "replace", project_root: tmpDir });
    await addStep.execute(
      {},
      {
        name: "replace",
        project_root: tmpDir,
        command: "keyboard",
        args: JSON.stringify({ udid: DEVICE, clear: true, text: "replacement" }),
      }
    );
    await flowFinishRecordingTool.execute({}, { name: "replace", project_root: tmpDir });

    const replayed: Call[] = [];
    const result = await createRunFlowTool(mockRegistry(replayed)).execute(
      {},
      { name: "replace", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toMatchObject({ ok: true });
    const keyboard = replayed.filter((c) => c.id === "keyboard");
    expect(keyboard).toHaveLength(1);
    // Both halves: the emptying AND the text it replaces the value with. A
    // replay that dropped `clear` would append instead, and pass.
    expect(keyboard[0]!.args).toMatchObject({ clear: true, text: "replacement", udid: DEVICE });
  });
});

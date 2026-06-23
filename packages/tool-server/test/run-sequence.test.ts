import { describe, expect, it, vi } from "vitest";
import { createRunSequenceTool } from "../src/tools/run-sequence";

// A minimal registry stub: records every invokeTool call and returns a marker.
function makeMockRegistry() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const registry = {
    invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { ok: true };
    }),
    // The execute body pre-flights each step's capability via getTool; these
    // tvOS/test tools aren't registered in the stub, so undefined (→ skip the
    // capability gate) is the right answer here.
    getTool: vi.fn(() => undefined),
  } as any;
  return { registry, calls };
}

const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";

describe("run-sequence", () => {
  it("allows TV steps and dispatches them in order with the shared udid injected", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute!(
      {},
      {
        udid: TVOS_UDID,
        steps: [
          { tool: "tv-remote", args: { button: "right" } },
          { tool: "keyboard", args: { text: "hello" } },
          { tool: "tv-remote", args: { button: "select" } },
        ],
      }
    );

    expect(result.completed).toBe(3);
    expect(result.total).toBe(3);
    // Every step ran through the registry with udid auto-injected.
    expect(calls.map((c) => c.tool)).toEqual(["tv-remote", "keyboard", "tv-remote"]);
    for (const c of calls) {
      expect(c.args.udid).toBe(TVOS_UDID);
    }
    expect(calls[0]!.args).toMatchObject({ button: "right", udid: TVOS_UDID });
  });

  it("rejects a tool that isn't in the allow-list and stops the sequence", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute!(
      {},
      {
        udid: TVOS_UDID,
        steps: [
          { tool: "tv-remote", args: { button: "down" } },
          { tool: "screenshot", args: {} },
          { tool: "tv-remote", args: { button: "select" } },
        ],
      }
    );

    // First step ran; the disallowed second step halts execution before the third.
    expect(result.completed).toBe(1);
    expect(calls.map((c) => c.tool)).toEqual(["tv-remote"]);
    const failed = result.steps[1];
    expect(failed && "error" in failed && failed.error).toMatch(/not allowed/);
  });

  it("declares no eager service so a tvOS udid never spawns simulator-server", () => {
    const { registry } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);
    // The registry resolves each step's services lazily; run-sequence itself
    // declares none — declaring simulator-server would hang for a tvOS udid.
    expect(tool.services({ udid: TVOS_UDID, steps: [] } as any)).toEqual({});
  });
});

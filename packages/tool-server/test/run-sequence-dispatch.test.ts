import { describe, it, expect, vi } from "vitest";
import type { Registry, ToolDefinition } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/interactions/run-sequence";

/**
 * Stub registry that only implements what run-sequence reaches for:
 *   - invokeTool: delegates to a map of fake sub-tool handlers
 *
 * run-sequence changed its own `services` from `{ simulatorServer: ... }` to
 * `{}` — the claim is that per-step `registry.invokeTool` handles service
 * resolution for each sub-tool on its own. These tests pin that claim so a
 * future regression (e.g. accidentally pre-resolving simulatorServer at
 * run-sequence level) shows up in CI instead of hands-on.
 */
function stubRegistry(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>
): Registry {
  const invokeTool = vi.fn(async (id: string, args: unknown) => {
    const handler = handlers[id];
    if (!handler) throw new Error(`no handler for ${id}`);
    return handler(args as Record<string, unknown>);
  });
  return { invokeTool } as unknown as Registry;
}

describe("run-sequence.services — no pre-warming", () => {
  it("declares no services; sub-tool service resolution is delegated to invokeTool", () => {
    // The previous version requested `{ simulatorServer: ... }` which
    // pre-warmed the iOS server. With unified dispatch, each sub-tool resolves
    // its own service. If a future change re-adds a service request here, the
    // iOS-only `SimulatorServer` URN shape will leak onto Android runs and
    // break them.
    const tool = createRunSequenceTool(stubRegistry({}));
    expect(
      tool.services({
        udid: "emulator-5554",
        steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.5 } }],
      })
    ).toEqual({});
  });
});

describe("run-sequence.execute — step forwarding & udid injection", () => {
  async function runOne(
    udid: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ calls: unknown[][]; result: unknown }> {
    const calls: unknown[][] = [];
    const registry = stubRegistry({
      [toolName]: async (a) => {
        calls.push([toolName, a]);
        return { ok: true };
      },
    });
    const tool = createRunSequenceTool(registry);
    const result = await tool.execute!({}, { udid, steps: [{ tool: toolName, args, delayMs: 0 }] });
    return { calls, result };
  }

  it("auto-injects udid into each step's args and forwards to registry.invokeTool", async () => {
    const { calls } = await runOne("11111111-2222-3333-4444-555555555555", "gesture-tap", {
      x: 0.5,
      y: 0.5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "gesture-tap",
      { x: 0.5, y: 0.5, udid: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  it("injects an Android udid identically — no platform branching at the sequence layer", async () => {
    const { calls } = await runOne("emulator-5554", "gesture-swipe", {
      fromX: 0.2,
      fromY: 0.5,
      toX: 0.8,
      toY: 0.5,
    });
    expect(calls[0]![1]).toMatchObject({ udid: "emulator-5554" });
  });

  it("lets the sub-tool overwrite an explicit udid in args if provided (udid wins from top-level)", async () => {
    // `{ ...step.args, udid }` places udid last, so it always overrides a stray
    // udid in args. Without this, a user mistake in the args object could
    // route a step to a different device.
    const iosUdid = "11111111-2222-3333-4444-555555555555";
    const { calls } = await runOne(iosUdid, "gesture-tap", {
      udid: "emulator-5554", // wrong — should be overridden
      x: 0.5,
      y: 0.5,
    });
    expect((calls[0]![1] as { udid: string }).udid).toBe(iosUdid);
  });
});

describe("run-sequence.execute — error propagation", () => {
  it("stops on the first thrown error and reports partial progress", async () => {
    const calls: string[] = [];
    const registry = stubRegistry({
      "gesture-tap": async () => {
        calls.push("tap");
        return { ok: true };
      },
      "gesture-swipe": async () => {
        calls.push("swipe");
        throw new Error("device offline");
      },
      "button": async () => {
        calls.push("button");
        return { ok: true };
      },
    });
    const tool = createRunSequenceTool(registry);
    const result = (await tool.execute!(
      {},
      {
        udid: "emulator-5554",
        steps: [
          { tool: "gesture-tap", args: { x: 0.1, y: 0.1 }, delayMs: 0 },
          {
            tool: "gesture-swipe",
            args: { fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.2 },
            delayMs: 0,
          },
          { tool: "button", args: { button: "home" }, delayMs: 0 }, // must NOT execute
        ],
      }
    )) as {
      completed: number;
      total: number;
      steps: Array<{ tool: string; error?: string; result?: unknown }>;
    };

    expect(calls).toEqual(["tap", "swipe"]); // button skipped
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ tool: "gesture-tap", result: { ok: true } });
    expect(result.steps[1]).toMatchObject({ tool: "gesture-swipe", error: "device offline" });
  });

  it("rejects a tool name outside the allow-list without invoking it", async () => {
    const invoke = vi.fn();
    const tool = createRunSequenceTool({ invokeTool: invoke } as unknown as Registry);
    const result = (await tool.execute!(
      {},
      {
        udid: "emulator-5554",
        steps: [{ tool: "reinstall-app", args: { appPath: "/x" } }],
      }
    )) as { steps: Array<{ error?: string }>; completed: number };

    expect(invoke).not.toHaveBeenCalled();
    expect(result.completed).toBe(0);
    expect(result.steps[0]!.error).toMatch(/not allowed in run-sequence/);
  });
});

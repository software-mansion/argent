import { beforeEach, describe, it, expect, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { z } from "zod";
import { Registry } from "@argent/registry";
import type { ToolContext } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { assertSupported } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { waitForScreenIdle } from "../src/tools/await-screen-idle";

vi.mock("../src/tools/await-screen-idle", () => ({ waitForScreenIdle: vi.fn() }));

const idle = vi.mocked(waitForScreenIdle);
const SETTLED = { settled: true, waitedMs: 150, polls: 4, aborted: false };
const CAPPED = { settled: false, waitedMs: 1000, polls: 12, aborted: false };

beforeEach(() => {
  idle.mockReset().mockResolvedValue(SETTLED);
});

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

function mockRegistry(invokeImpl?: (id: string, args: unknown) => unknown): Registry {
  return {
    // No capability declared → run-sequence skips the per-step assertSupported.
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (id: string, args: unknown) => invokeImpl?.(id, args) ?? { ok: true }),
  } as unknown as Registry;
}

// Step dispatches and settle waits, in call order; a settle reads as "await-screen-idle".
function invokedTools(registry: Registry): string[] {
  const invoke = (registry.invokeTool as ReturnType<typeof vi.fn>).mock;
  const calls = [
    ...invoke.calls.map((c, i) => ({ order: invoke.invocationCallOrder[i]!, id: c[0] as string })),
    ...idle.mock.invocationCallOrder.map((order) => ({ order, id: "await-screen-idle" })),
  ];
  return calls.sort((a, b) => a.order - b.order).map((c) => c.id);
}

async function settledAfter(
  steps: Array<{ tool: string; args: Record<string, unknown> }>,
  udid = IOS
): Promise<string[]> {
  idle.mockClear();
  const registry = mockRegistry();
  await createRunSequenceTool(registry).execute(
    {},
    { udid, steps: steps.map((s) => ({ ...s, delayMs: 0 })) }
  );
  return invokedTools(registry);
}

const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
// iOS-shaped udid so `resolveDevice` classifies it as an iOS simulator without
// touching a real device (classification is purely shape-based).
const IOS = "11111111-1111-1111-1111-111111111111";
const HARMONY = "harmony-025DEK236V035771";

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

  it("accepts a HarmonyOS device, and stops at the first step that platform cannot run", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);
    // The outer gate runs in the HTTP layer, not in execute().
    expect(() =>
      assertSupported("run-sequence", tool.capability, resolveDevice(HARMONY))
    ).not.toThrow();

    registry.getTool = vi.fn((id: string) =>
      id === "gesture-tap" ? gestureTapTool : gestureRotateTool
    );

    const result = await tool.execute!(
      {},
      {
        udid: HARMONY,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
          {
            tool: "gesture-rotate",
            args: { centerX: 0.5, centerY: 0.5, radius: 0.15, startAngle: 0, endAngle: 90 },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.6 } },
        ],
      }
    );

    expect(result.completed).toBe(1);
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
    expect(calls[0]!.args.udid).toBe(HARMONY);
    const blocked = result.steps[1];
    expect(blocked && "error" in blocked && blocked.error).toContain(
      "is not supported on harmony device"
    );
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

  it("runs each step in order, injecting the shared udid", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "keyboard", args: { text: "hi" }, delayMs: 0 },
        ],
      }
    );

    expect(result).toMatchObject({ completed: 2, total: 2 });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(1, "gesture-tap", {
      x: 0.5,
      y: 0.3,
      udid: IOS,
    });
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith(registry, expect.objectContaining({ id: IOS }), {
      timeoutMs: 1000,
      pollIntervalMs: 50,
      minStableMs: 100,
      signal: undefined,
      stopOnReadError: true,
      emptyTreeIsStable: true,
      androidHelperOnly: true,
    });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(2, "keyboard", { text: "hi", udid: IOS });
    expect(invokedTools(registry)).toEqual(["gesture-tap", "await-screen-idle", "keyboard"]);
  });

  it("skips the settle wait with settle:false", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    await tool.execute(
      {},
      {
        udid: IOS,
        settle: false,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "keyboard", args: { text: "hi" }, delayMs: 0 },
        ],
      }
    );

    expect(idle).not.toHaveBeenCalled();
    expect(registry.invokeTool).toHaveBeenNthCalledWith(2, "keyboard", { text: "hi", udid: IOS });
  });

  it("skips the settle wait after a step that passes settle:false", async () => {
    const tap = { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 };
    const registry = mockRegistry();

    await createRunSequenceTool(registry).execute(
      {},
      { udid: IOS, steps: [{ ...tap, settle: false }, tap, tap] }
    );

    expect(invokedTools(registry)).toEqual([
      "gesture-tap",
      "gesture-tap",
      "await-screen-idle",
      "gesture-tap",
    ]);
  });

  it("settles after a key or text that submits or dismisses, not after editing keys", async () => {
    const tap = { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } };
    expect(await settledAfter([{ tool: "keyboard", args: { text: "query\n" } }, tap])).toContain(
      "await-screen-idle"
    );
    expect(await settledAfter([{ tool: "keyboard", args: { key: "enter" } }, tap])).toContain(
      "await-screen-idle"
    );
    expect(await settledAfter([{ tool: "keyboard", args: { key: "escape" } }, tap])).toContain(
      "await-screen-idle"
    );
    expect(
      await settledAfter([
        { tool: "keyboard", args: { key: "backspace" } },
        { tool: "keyboard", args: { key: "backspace" } },
      ])
    ).toEqual(["keyboard", "keyboard"]);
    expect(await settledAfter([{ tool: "keyboard", args: { text: "hi" } }, tap])).toEqual([
      "keyboard",
      "gesture-tap",
    ]);
  });

  it.each([{ key: "return" }, { key: "esc" }, { key: "ENTER" }, { text: "query\r" }])(
    "settles after keyboard %o",
    async (args) => {
      expect(
        await settledAfter([
          { tool: "keyboard", args },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ])
      ).toEqual(["keyboard", "await-screen-idle", "gesture-tap"]);
    }
  );

  it.each([
    "paste",
    "rotate",
    "fold",
    "gesture-tap",
    "gesture-swipe",
    "gesture-scroll",
    "gesture-drag",
    "gesture-custom",
    "gesture-pinch",
    "gesture-rotate",
    "button",
  ])("settles after %s", async (step) => {
    expect(
      await settledAfter([
        { tool: step, args: {} },
        { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
      ])
    ).toEqual([step, "await-screen-idle", "gesture-tap"]);
  });

  it("does not settle before a shake, so a shake can race a dismissal", async () => {
    expect(
      await settledAfter([
        { tool: "gesture-swipe", args: {} },
        { tool: "shake", args: {} },
      ])
    ).toEqual(["gesture-swipe", "shake"]);
  });

  it.each(["tv-remote", "shake"])("does not settle after %s", async (step) => {
    expect(
      await settledAfter([
        { tool: step, args: {} },
        { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
      ])
    ).toEqual([step, "gesture-tap"]);
  });

  it("does not settle between consecutive swipe, scroll and drag steps", async () => {
    expect(
      await settledAfter([
        { tool: "gesture-swipe", args: {} },
        { tool: "gesture-swipe", args: {} },
        { tool: "gesture-scroll", args: {} },
        { tool: "gesture-drag", args: {} },
        { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
      ])
    ).toEqual([
      "gesture-swipe",
      "gesture-swipe",
      "gesture-scroll",
      "gesture-drag",
      "await-screen-idle",
      "gesture-tap",
    ]);
  });

  it("does not settle on HarmonyOS, where one tree read outlasts the cap", async () => {
    const tap = { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } };
    expect(await settledAfter([tap, tap], HARMONY)).toEqual(["gesture-tap", "gesture-tap"]);
  });

  it("does not settle on a device the idle tool does not support", async () => {
    const registry = {
      getTool: vi.fn((id: string) =>
        id === "await-screen-idle" ? { capability: { apple: { simulator: true } } } : undefined
      ),
      invokeTool: vi.fn(async () => ({ ok: true })),
    } as unknown as Registry;

    const result = await createRunSequenceTool(registry).execute(
      {},
      {
        udid: "amazon-0123456789",
        steps: [
          { tool: "keyboard", args: { key: "enter" }, delayMs: 0 },
          { tool: "tv-remote", args: { button: "select" }, delayMs: 0 },
        ],
      }
    );

    expect(invokedTools(registry)).toEqual(["keyboard", "tv-remote"]);
    expect(result.completed).toBe(2);
  });

  it("keeps going when the settle wait fails", async () => {
    idle.mockRejectedValue(new Error("no tree"));
    const registry = mockRegistry(() => ({ tapped: true }));

    const result = await createRunSequenceTool(registry).execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.6 }, delayMs: 0 },
        ],
      }
    );

    expect(result).toMatchObject({ completed: 2, total: 2 });
    expect(result.steps.every((s) => "result" in s)).toBe(true);
  });

  const tap = { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 };

  it.each([
    [
      "a read fails",
      () => Promise.resolve({ ...CAPPED, polls: 1, readError: "Target closed" }),
      "the element tree could not be read (Target closed)",
    ],
    [
      "a read fails after several good reads",
      () => Promise.resolve({ ...CAPPED, polls: 5, readError: "Target closed" }),
      "the element tree could not be read (Target closed)",
    ],
    [
      "one read takes the whole cap",
      () => Promise.resolve({ ...CAPPED, polls: 2 }),
      "the element tree could not be read twice within 1000ms",
    ],
    [
      "two reads differ",
      () => Promise.resolve({ ...CAPPED, polls: 3 }),
      "the screen was still changing at the 1000ms cap",
    ],
    [
      "the wait throws",
      () => Promise.reject(new Error("no tree")),
      "the element tree could not be read (no tree)",
    ],
  ])("stops settling after two waits in a row where %s", async (_label, outcome, reason) => {
    idle.mockImplementation(outcome);
    const registry = mockRegistry();

    const result = await createRunSequenceTool(registry).execute(
      {},
      { udid: IOS, steps: [tap, tap, tap, tap] }
    );

    expect(invokedTools(registry)).toEqual([
      "gesture-tap",
      "await-screen-idle",
      "gesture-tap",
      "await-screen-idle",
      "gesture-tap",
      "gesture-tap",
    ]);
    expect(result.note).toBe(
      `Stopped waiting for the screen to settle after step 2: 2 waits in a row did not settle, the last because ${reason}. Later steps ran without the wait.`
    );
  });

  it.each([
    ["capped", CAPPED],
    ["unreadable", { ...CAPPED, polls: 1, readError: "slow read" }],
  ])(
    "keeps settling after one %s wait, so a later transition is still caught",
    async (_, first) => {
      idle.mockResolvedValueOnce(first);
      const registry = mockRegistry();

      const result = await createRunSequenceTool(registry).execute(
        {},
        { udid: IOS, steps: [tap, tap, tap] }
      );

      expect(invokedTools(registry)).toEqual([
        "gesture-tap",
        "await-screen-idle",
        "gesture-tap",
        "await-screen-idle",
        "gesture-tap",
      ]);
      expect(result.note).toBeUndefined();
    }
  );

  it("adds no note when the waits stop but no later step would have had one", async () => {
    idle.mockResolvedValue(CAPPED);
    const shake = { tool: "shake", args: {}, delayMs: 0 };

    for (const steps of [
      [tap, tap, tap],
      [tap, tap, tap, shake],
    ]) {
      idle.mockClear();
      const result = await createRunSequenceTool(mockRegistry()).execute({}, { udid: IOS, steps });

      expect(idle).toHaveBeenCalledTimes(2);
      expect(result.note).toBeUndefined();
    }
  });

  it("does not settle on a physical iPhone, where a read holds up the next command", async () => {
    expect(await settledAfter([tap, tap], "00008110-000978540290401E")).toEqual([
      "gesture-tap",
      "gesture-tap",
    ]);
  });

  it("resets the count when a wait settles", async () => {
    idle
      .mockResolvedValueOnce(CAPPED)
      .mockResolvedValueOnce(SETTLED)
      .mockResolvedValueOnce(CAPPED)
      .mockResolvedValueOnce(CAPPED);
    const registry = mockRegistry();

    const result = await createRunSequenceTool(registry).execute(
      {},
      { udid: IOS, steps: [tap, tap, tap, tap, tap, tap] }
    );

    expect(idle).toHaveBeenCalledTimes(4);
    expect(result.note).toMatch(/after step 4:/);
  });

  it("does not count a wait after a swipe that hits the cap", async () => {
    idle.mockResolvedValue(CAPPED);
    const swipe = { tool: "gesture-swipe", args: {}, delayMs: 0 };
    const registry = mockRegistry();

    const result = await createRunSequenceTool(registry).execute(
      {},
      { udid: IOS, steps: [tap, swipe, tap, tap, tap] }
    );

    expect(idle).toHaveBeenCalledTimes(3);
    expect(result.note).toMatch(/after step 3:/);
  });

  it("does not record a settle wait as a tool invocation", async () => {
    const registry = mockRegistry();
    const recordChildInvocation = vi.fn(() => () => {});

    await createRunSequenceTool(registry).execute({}, { udid: IOS, steps: [tap, tap] }, {
      recordChildInvocation,
    } as unknown as ToolContext);

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("stops at an unrecognized tool without invoking it", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "not-a-tool", args: {}, delayMs: 0 }] }
    );

    expect(result.completed).toBe(0);
    expect(result.steps[0]).toMatchObject({
      tool: "not-a-tool",
      error: expect.stringContaining("not allowed"),
    });
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("stops the sequence when an await-ui-element step reports an unmet condition", async () => {
    const registry = mockRegistry((id: string) => {
      if (id === "await-ui-element") {
        return {
          success: false,
          elapsed: 5000,
          note: "no element matched the selector before timeout",
        };
      }
      return { tapped: true };
    });
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          {
            tool: "await-ui-element",
            args: { condition: "visible", selector: { text: "Continue" } },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    // The trailing tap must NOT run.
    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(2);
    const last = result.steps[1] as { tool: string; error?: string };
    expect(last.tool).toBe("await-ui-element");
    expect(last.error).toMatch(/condition not met/i);
    expect(last.error).toMatch(/no element matched/i);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
  });

  it("continues past an await-ui-element step whose condition is met", async () => {
    const registry = mockRegistry((id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      return { tapped: true };
    });
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          {
            tool: "await-ui-element",
            args: { condition: "visible", selector: { text: "Continue" } },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    expect(invokedTools(registry)).toEqual([
      "gesture-tap",
      "await-ui-element",
      "await-screen-idle",
      "gesture-tap",
    ]);
    expect(result.completed).toBe(3);
    expect(result.steps.every((s) => "result" in s)).toBe(true);
  });

  it("only the await-ui-element tool's success:false halts — other tools are unaffected", async () => {
    // A non-wait step returning a success:false-shaped object must NOT stop the run.
    const registry = mockRegistry(() => ({ success: false }));
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        settle: false,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.completed).toBe(2);
  });

  it("forwards the request abort signal into each sub-tool invocation", async () => {
    const registry = mockRegistry(() => ({ tapped: true }));
    const tool = createRunSequenceTool(registry);
    const controller = new AbortController();

    await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.9 } }] },
      { signal: controller.signal } as unknown as ToolContext
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const opts = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not run any step when the signal is already aborted", async () => {
    const registry = mockRegistry(() => ({ tapped: true }));
    const tool = createRunSequenceTool(registry);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.9 } }],
      },
      { signal: controller.signal } as unknown as ToolContext
    );

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(result.completed).toBe(0);
  });

  it("propagates the request's telemetry attribution to every sub-tool", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await tool.execute(
      {},
      {
        udid: IOS,
        settle: false,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "gesture-swipe", args: { fromX: 0.5 }, delayMs: 0 },
        ],
      },
      ctx
    );

    // One recorded child invocation per step, each with its own id.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);

    // Each step's own args (with the injected udid) reach the recorder so it can
    // attribute the gesture to the right platform.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(
      1,
      ids[0],
      expect.objectContaining({ x: 0.5, y: 0.3, udid: IOS })
    );
    expect(recordChildInvocation).toHaveBeenNthCalledWith(
      2,
      ids[1],
      expect.objectContaining({ fromX: 0.5, udid: IOS })
    );

    // Each sub-tool is dispatched under its minted id, with the recorder
    // forwarded so deeper nesting keeps the attribution.
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.3, udid: IOS }),
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "gesture-swipe",
      expect.objectContaining({ fromX: 0.5, udid: IOS }),
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("forwards the request's abort signal to each sub-tool so a long step is cancellable", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const controller = new AbortController();
    const ctx = { artifacts: {}, signal: controller.signal } as unknown as ToolContext;

    await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "tv-remote", args: { button: "right" }, delayMs: 0 }] },
      ctx
    );

    // The sub-tool must receive `signal` via its options — otherwise its own
    // `throwIfAborted` is a no-op and a long step runs to completion after the
    // client disconnects. (No attribution context here, so this is the
    // pass-through branch.)
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tv-remote",
      expect.objectContaining({ button: "right", udid: IOS }),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("stops before the next step once the signal is aborted", async () => {
    const controller = new AbortController();
    // Abort as soon as the first step runs; the loop must not dispatch the second.
    const registry = mockRegistry(() => {
      controller.abort();
      return { ok: true };
    });
    const tool = createRunSequenceTool(registry);
    const ctx = { artifacts: {}, signal: controller.signal } as unknown as ToolContext;

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "tv-remote", args: { button: "up" }, delayMs: 0 },
          { tool: "tv-remote", args: { button: "down" }, delayMs: 0 },
        ],
      },
      ctx
    );

    expect(result.completed).toBe(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  describe("a step whose args the sub-tool rejects", () => {
    const liveRegistry = () => {
      const registry = new Registry();
      const executed: string[] = [];
      registry.registerTool({
        id: "gesture-tap",
        description: "test double for gesture-tap",
        zodSchema: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
        services: () => ({}),
        execute: async () => {
          executed.push("gesture-tap");
          return { ok: true };
        },
      } as never);
      registry.registerTool({
        id: "keyboard",
        description: "test double for keyboard",
        zodSchema: z.object({ udid: z.string(), text: z.string().optional() }),
        services: () => ({}),
        execute: async () => {
          executed.push("keyboard");
          return { ok: true };
        },
      } as never);
      return { registry, executed };
    };

    it("names only the keys the AUTHOR wrote, not the injected udid", async () => {
      const { registry } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } }] }
      );

      const error = (result.steps[0] as { error?: string }).error!;
      expect(error).toContain("`x` is required");
      expect(error).toContain("You sent: `xx`, `y`.");
      expect(error).not.toContain("`udid`");
    });

    it("STOPS the sequence, leaving the later steps un-run", async () => {
      const { registry, executed } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        {
          udid: IOS,
          steps: [
            { tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } },
            { tool: "keyboard", args: { text: "hello" } },
          ],
        }
      );

      expect(result.steps).toHaveLength(1);
      expect(result.completed).toBe(0);
      expect(result.total).toBe(2);
      expect(executed).toEqual([]);
    });

    it("still emits the step's own invoked/failed events", async () => {
      const { registry } = liveRegistry();
      const events: string[] = [];
      registry.events.on("toolInvoked", (id) => events.push(`invoked:${id}`));
      registry.events.on("toolFailed", (id) => events.push(`failed:${id}`));
      const tool = createRunSequenceTool(registry);

      await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } }] }
      );

      expect(events).toEqual(["invoked:gesture-tap", "failed:gesture-tap"]);
    });

    it("still accepts a step that omits udid, since it is injected", async () => {
      const { registry, executed } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.3 } }] }
      );

      expect((result.steps[0] as { error?: string }).error).toBeUndefined();
      expect(executed).toEqual(["gesture-tap"]);
    });
  });
});

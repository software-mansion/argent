import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getFailureSignal,
  zodObjectToJsonSchema,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import type { DescribeNode } from "../src/tools/describe/contract";

// The facade reads the device tree through `fetchTree`; stub only that and keep
// the real matching engine (findAll / selectorToFrame / treeFingerprint) so the
// settle, ranking and scroll logic under test runs for real. `selectorToFrame`
// is wrapped in a spy so the ranking-delegation test can assert it was used.
vi.mock("../src/utils/ui-tree-match", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ui-tree-match")>();
  return {
    ...actual,
    fetchTree: vi.fn(),
    selectorToFrame: vi.fn(actual.selectorToFrame),
  };
});

import { fetchTree, selectorToFrame } from "../src/utils/ui-tree-match";
import { buildUiFacade, type FacadeEnv } from "../src/tools/run-script/api";
import { runScript } from "../src/tools/run-script/runtime";
import { createRunScriptTool } from "../src/tools/run-script";
import { runScriptZodSchema } from "../src/tools/run-script/schema";
import { resolveDevice } from "../src/utils/device-info";

// iOS-shaped udid: `resolveDevice` classifies it as an iOS simulator by shape
// alone, so no real device is touched.
const IOS = "11111111-1111-1111-1111-111111111111";

function node(partial: Partial<DescribeNode>): DescribeNode {
  return {
    role: "AXOther",
    frame: { x: 0, y: 0, width: 0, height: 0 },
    children: [],
    ...partial,
  };
}

function treeWith(children: DescribeNode[]): { tree: DescribeNode; source: "ax-service" } {
  return {
    tree: node({ role: "root", frame: { x: 0, y: 0, width: 1, height: 1 }, children }),
    source: "ax-service",
  };
}

// A visible, matchable leaf.
function leaf(label: string, y = 0.4): DescribeNode {
  return node({ role: "AXButton", label, frame: { x: 0.4, y, width: 0.2, height: 0.08 } });
}

const fetchTreeMock = vi.mocked(fetchTree);
const selectorToFrameSpy = vi.mocked(selectorToFrame);

function mockRegistry(invokeImpl?: (id: string, args: any) => unknown): Registry {
  return {
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (id: string, args: unknown) => invokeImpl?.(id, args) ?? { ok: true }),
  } as unknown as Registry;
}

function facadeEnv(registry: Registry, onStep = () => {}): FacadeEnv {
  // Mirror production: runtime always hands the facade a subCtx carrying the
  // deadline signal, so sub-tool invocations get a 3rd options argument.
  const signal = new AbortController().signal;
  return {
    registry,
    device: resolveDevice(IOS),
    signal,
    subCtx: { signal } as ToolContext,
    onStep,
  };
}

beforeEach(() => {
  fetchTreeMock.mockReset();
  selectorToFrameSpy.mockClear();
  // Default: an empty screen, overridden per test.
  fetchTreeMock.mockResolvedValue(treeWith([]) as any);
});

describe("run-script schema", () => {
  it("accepts a minimal valid input", () => {
    expect(runScriptZodSchema.safeParse({ udid: IOS, script: "return 1;" }).success).toBe(true);
  });

  it("rejects a missing or empty script and an out-of-range timeout", () => {
    expect(runScriptZodSchema.safeParse({ udid: IOS }).success).toBe(false);
    expect(runScriptZodSchema.safeParse({ udid: IOS, script: "" }).success).toBe(false);
    expect(runScriptZodSchema.safeParse({ udid: IOS, script: "x", timeout_ms: 0 }).success).toBe(
      false
    );
    expect(
      runScriptZodSchema.safeParse({ udid: IOS, script: "x", timeout_ms: 600001 }).success
    ).toBe(false);
  });

  it("advertises a plain object schema with no top-level combinator", () => {
    const schema = zodObjectToJsonSchema(runScriptZodSchema) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(typeof schema.properties).toBe("object");
    for (const kw of ["oneOf", "anyOf", "allOf", "not", "if"]) {
      expect(kw in schema).toBe(false);
    }
    // udid is top level so MCP auto-capture can find the device.
    expect(Object.keys(schema.properties as object)).toContain("udid");
  });
});

describe("run-script runtime", () => {
  it("runs a script through the facade and counts its steps", async () => {
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "await ui.tapPoint(0.5, 0.5); await ui.pressKey('enter');",
      timeoutMs: 5000,
      ctx: undefined,
    });

    expect(result).toEqual({ completed: true, logs: "", steps: 2 });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "gesture-tap",
      { x: 0.5, y: 0.5, udid: IOS },
      expect.anything()
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "keyboard",
      { key: "enter", udid: IOS },
      expect.anything()
    );
  });

  it("branches on ui.exists without tapping when the element is absent", async () => {
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Present")]) as any);
    const registry = mockRegistry();

    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script:
        "if (await ui.exists({ text: 'Missing' })) { await ui.tapPoint(0, 0); } else { console.log('absent'); }",
      timeoutMs: 5000,
      ctx: undefined,
    });

    expect(result.completed).toBe(true);
    expect(result.logs).toContain("absent");
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("classifies a compile error as RUN_SCRIPT_SYNTAX_ERROR", async () => {
    const registry = mockRegistry();
    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "this is ) not valid",
      timeoutMs: 5000,
      ctx: undefined,
    }).catch((e) => e);
    expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_SYNTAX_ERROR");
  });

  it("classifies a thrown error as RUN_SCRIPT_THREW and renders <script> frames", async () => {
    const registry = mockRegistry();
    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "throw new Error('boom');",
      timeoutMs: 5000,
      ctx: undefined,
    }).catch((e) => e);
    expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_THREW");
    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).toContain("<script>");
  });

  it("classifies a deadline overrun as RUN_SCRIPT_TIMEOUT and aborts the in-flight step", async () => {
    // A sub-tool that never resolves: the run must end on its own deadline.
    const registry = mockRegistry(() => new Promise(() => {}));
    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "await ui.awaitIdle();",
      timeoutMs: 80,
      ctx: undefined,
    }).catch((e) => e);
    expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_TIMEOUT");
  });

  it("tail-caps captured console output", async () => {
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "for (let i = 0; i < 500; i++) console.log('X'.repeat(60));",
      timeoutMs: 5000,
      ctx: undefined,
    });
    expect(result.logs.length).toBeLessThanOrEqual(4001);
    expect(result.logs.startsWith("…")).toBe(true);
  });

  it("stops at the next step once an external signal aborts", async () => {
    const controller = new AbortController();
    // Abort as the first keyboard step runs; the second must not dispatch.
    const registry = mockRegistry((id: string) => {
      if (id === "keyboard") controller.abort();
      return { ok: true };
    });

    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "await ui.pressKey('a'); await ui.pressKey('b');",
      timeoutMs: 5000,
      ctx: { signal: controller.signal } as ToolContext,
    }).catch((e) => e);

    expect((err as Error).name).toBe("ScriptAbortError");
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("kills a synchronous infinite loop at the deadline (RUN_SCRIPT_TIMEOUT)", async () => {
    // A `while (true) {}` blocks the child's event loop, so no in-script timer
    // could ever fire. The parent's deadline kills the child process instead.
    const registry = mockRegistry();
    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "while (true) {}",
      timeoutMs: 300,
      ctx: undefined,
    }).catch((e) => e);
    expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_TIMEOUT");
  }, 15000);

  it("isolates a constructor escape in a throwaway child with no host state", async () => {
    // The classic vm escape now lands in a separate process spawned with an
    // empty env, so a sentinel the parent holds is unreachable.
    const sentinel = "argent-parent-sentinel-8f3ac1";
    const prev = process.env.ARGENT_TEST_SENTINEL;
    process.env.ARGENT_TEST_SENTINEL = sentinel;
    try {
      const registry = mockRegistry();
      const result = await runScript({
        registry,
        device: resolveDevice(IOS),
        script:
          "const p = ui.describe.constructor('return process')();" +
          "console.log('sentinel=' + (p.env.ARGENT_TEST_SENTINEL || 'ABSENT'));",
        timeoutMs: 5000,
        ctx: undefined,
      });
      expect(result.completed).toBe(true);
      expect(result.logs).toContain("sentinel=ABSENT");
      expect(result.logs).not.toContain(sentinel);
    } finally {
      if (prev === undefined) delete process.env.ARGENT_TEST_SENTINEL;
      else process.env.ARGENT_TEST_SENTINEL = prev;
    }
  }, 15000);

  it("caps a console flood at record time", async () => {
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: "for (let i = 0; i < 20000; i++) console.log('X'.repeat(200));",
      timeoutMs: 10000,
      ctx: undefined,
    });
    expect(result.logs.length).toBeLessThanOrEqual(4001);
    expect(result.logs.startsWith("…")).toBe(true);
  }, 15000);

  it("carries the console tail into the timeout failure", async () => {
    // The marker is logged before the child blocks its own event loop, so only a
    // record streamed to the parent as it is produced can survive the kill — the
    // child never gets to send its final logs.
    const registry = mockRegistry();
    const marker = "before-the-loop-marker-42";
    const err = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: `console.log(${JSON.stringify(marker)}); while (true) {}`,
      timeoutMs: 300,
      ctx: undefined,
    }).catch((e) => e);
    expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_TIMEOUT");
    expect((err as Error).message).toContain(marker);
  }, 15000);

  it("rejects an inherited-member ui call (constructor / hasOwnProperty) as unknown", async () => {
    // A compromised child could name an inherited member to have the parent invoke
    // it; the own-property guard makes those the same clean unknown-method error a
    // typo would get, and no sub-tool ever runs.
    const registry = mockRegistry();
    for (const method of ["constructor", "hasOwnProperty"]) {
      const err = await runScript({
        registry,
        device: resolveDevice(IOS),
        script: `await ui.${method}();`,
        timeoutMs: 5000,
        ctx: undefined,
      }).catch((e) => e);
      expect(getFailureSignal(err)?.error_code).toBe("RUN_SCRIPT_THREW");
      expect((err as Error).message).toContain(`ui.${method} is not a function`);
    }
    expect(registry.invokeTool).not.toHaveBeenCalled();
  }, 15000);

  it("bounds a single giant log line with a truncation marker", async () => {
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: 'console.log("X".repeat(50000));',
      timeoutMs: 5000,
      ctx: undefined,
    });
    expect(result.completed).toBe(true);
    // Capped at record time so one huge line can't be retained whole, then the
    // final tail-cap applies as usual.
    expect(result.logs.length).toBeLessThanOrEqual(4001);
    expect(result.logs).toContain("…");
  }, 15000);

  it("flags secretsUsed when a script types a dynamically built placeholder", async () => {
    fetchTreeMock.mockResolvedValue(treeWith([leaf("PW")]) as any);
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      // Built at runtime, so params.script carries no marker for an arg-scan.
      script: 'await ui.fill({ text: "PW" }, "{{se" + "cret:X}}");',
      timeoutMs: 5000,
      ctx: undefined,
    });
    expect(result.completed).toBe(true);
    expect(result.secretsUsed).toBe(true);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "keyboard",
      expect.objectContaining({ text: "{{secret:X}}", udid: IOS }),
      expect.anything()
    );
  }, 15000);

  it("omits secretsUsed for a run that types no secret", async () => {
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Email")]) as any);
    const registry = mockRegistry();
    const result = await runScript({
      registry,
      device: resolveDevice(IOS),
      script: 'await ui.fill({ text: "Email" }, "hello");',
      timeoutMs: 5000,
      ctx: undefined,
    });
    expect(result.completed).toBe(true);
    expect(result.secretsUsed).toBeUndefined();
  }, 15000);
});

describe("run-script ui facade", () => {
  it("taps the ranked frame and fails with STEP_FAILED when the screen does not change", async () => {
    // The same tree every read: settle is stable and the post-tap fingerprint is
    // unchanged, so tap concludes the tap was lost.
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Login")]) as any);
    const registry = mockRegistry();
    const ui = buildUiFacade(facadeEnv(registry));

    const err = await ui.tap({ text: "Login" }).catch((e) => e);
    expect((err as Error).message).toContain("no visible change");
    // Ranking was delegated to selectorToFrame, and the tap was dispatched.
    expect(selectorToFrameSpy).toHaveBeenCalled();
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ udid: IOS }),
      expect.anything()
    );
  });

  it("resolves tap when the screen changes after the tap", async () => {
    fetchTreeMock
      .mockResolvedValueOnce(treeWith([leaf("Login")]) as any)
      .mockResolvedValueOnce(treeWith([leaf("Login")]) as any)
      .mockResolvedValue(treeWith([leaf("Welcome")]) as any);
    const registry = mockRegistry();
    const ui = buildUiFacade(facadeEnv(registry));

    await expect(ui.tap({ text: "Login" })).resolves.toBeUndefined();
  });

  it("fills a field: taps it, then types via the keyboard tool", async () => {
    // No node reports `focused`, so the focus wait falls back to its head start.
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Email")]) as any);
    const registry = mockRegistry();
    const ui = buildUiFacade(facadeEnv(registry));

    await ui.fill({ text: "Email" }, "hello");

    const tools = (registry.invokeTool as any).mock.calls.map((c: any[]) => c[0]);
    expect(tools).toContain("gesture-tap");
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "keyboard",
      expect.objectContaining({ text: "hello", udid: IOS }),
      expect.anything()
    );
  });

  it("fills via the paste tool when mode is 'paste'", async () => {
    fetchTreeMock.mockResolvedValue(treeWith([leaf("OTP")]) as any);
    const registry = mockRegistry();
    const ui = buildUiFacade(facadeEnv(registry));

    await ui.fill({ text: "OTP" }, "123456", { mode: "paste" });

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "paste",
      expect.objectContaining({ text: "123456", udid: IOS }),
      expect.anything()
    );
  });

  it("scrollUntilVisible stops when a swipe does not move the screen", async () => {
    // Target never present, tree never changes → end-of-scroll after one swipe.
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Top")]) as any);
    const registry = mockRegistry();
    const ui = buildUiFacade(facadeEnv(registry));

    const found = await ui.scrollUntilVisible({ text: "Bottom" }, { maxScrolls: 5 });
    expect(found).toBe(false);
    const swipes = (registry.invokeTool as any).mock.calls.filter(
      (c: any[]) => c[0] === "gesture-swipe"
    );
    expect(swipes).toHaveLength(1);
  });

  it("counts each facade call as one step", async () => {
    fetchTreeMock.mockResolvedValue(treeWith([leaf("Row")]) as any);
    const registry = mockRegistry();
    let steps = 0;
    const ui = buildUiFacade(facadeEnv(registry, () => (steps += 1)));

    await ui.exists({ text: "Row" });
    await ui.tapPoint(0.5, 0.5);
    await ui.sleep(1);
    expect(steps).toBe(3);
  });
});

describe("createRunScriptTool", () => {
  it("is gated behind the run-script flag and declares all three interaction messages", () => {
    const tool = createRunScriptTool(mockRegistry());
    expect(tool.id).toBe("run-script");
    expect(tool.featureFlag).toBe("run-script");
    expect(tool.longRunning).toBe(true);
    expect(tool.interaction?.startedMsg).toBeTypeOf("function");
    expect(tool.interaction?.completedMsg).toBeTypeOf("function");
    expect(tool.interaction?.failedMsg).toBeTypeOf("function");
    expect(tool.services({ udid: IOS, script: "x" })).toEqual({});
  });

  it("executes via the tool entry point", async () => {
    const registry = mockRegistry();
    const tool = createRunScriptTool(registry);
    const result = await tool.execute({}, { udid: IOS, script: "await ui.button('home');" });
    expect(result).toMatchObject({ completed: true, steps: 1 });
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "button",
      expect.objectContaining({ button: "home", udid: IOS }),
      expect.anything()
    );
  });
});

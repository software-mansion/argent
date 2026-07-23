import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";
import { ArtifactStore } from "../../src/artifacts";

// Serve the flow tree directly so these tests can move it during the pixel
// phase and verify the combined settle revalidates it before dispatch.
let currentTree: () => DescribeNode | Promise<DescribeNode>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: await currentTree(),
      source: "native-devtools",
    })
  ),
}));

// Keep the real pixel comparison; script only the capture, so the settle loop's
// real motion logic is exercised against frames we control.
vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>();
  return { ...actual, capturePixels: vi.fn() };
});

import { capturePixels } from "../../src/tools/flows/flow-pixels";
import { runDirective, settleTree } from "../../src/tools/flows/flow-actions";
import { FlowTreeSourceUnavailableError } from "../../src/tools/flows/flow-errors";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}
function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

/** A solid-color RGBA frame, used to script capture readings. */
function solid(color: [number, number, number]): PixelFrame {
  const [r, g, b] = color;
  const data = Buffer.alloc(4 * 4);
  for (let i = 0; i < 4; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: 2, height: 2, data };
}

function mockRegistry(
  calls: string[],
  signal?: AbortSignal,
  onInvoke?: (id: string) => void
): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (signal?.aborted) throw new Error("aborted");
      calls.push(id);
      onInvoke?.(id);
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(
  name: string,
  steps: FlowStep[] = [{ kind: "tap", selector: { text: "Go", loose: true } }]
): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({
      executionPrerequisite: "",
      steps,
    }),
    "utf8"
  );
}

async function run(
  calls: string[],
  signal?: AbortSignal,
  name = "tap-go",
  onInvoke?: (id: string) => void
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry(calls, signal, onInvoke));
  const ctx = signal ? ({ signal } as ToolContext) : undefined;
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }, ctx);
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pixel-settle-"));
  currentTree = () =>
    screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
  vi.mocked(capturePixels).mockReset();
  await writeFlow("tap-go");
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("pixel settle backstop", () => {
  it("types a persistent tree-source outage while preserving its error details", async () => {
    vi.useFakeTimers();
    const source = Object.assign(new Error("native devtools is unavailable (service down)"), {
      failure: { code: "SERVICE_UNAVAILABLE" },
    });
    currentTree = () => Promise.reject(source);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const caught = settleTree(env).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await caught;

    expect(err).toBeInstanceOf(FlowTreeSourceUnavailableError);
    expect(err).toMatchObject({
      message: source.message,
      cause: source,
      failure: source.failure,
    });
  });

  it("bounds a never-resolving initial tree read by the hard settle deadline", async () => {
    vi.useFakeTimers();
    currentTree = () => new Promise(() => {});
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, {
      mode: "tree-only",
      absoluteDeadline: Date.now() + 1_000,
    });
    const rejected = expect(pending).rejects.toThrow(
      /timed out reading the UI tree while settling/
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("aborts a run while its initial tree read is hung without dispatching the gesture", async () => {
    const controller = new AbortController();
    let markTreeReadStarted!: () => void;
    const treeReadStarted = new Promise<void>((resolve) => {
      markTreeReadStarted = resolve;
    });
    currentTree = () => {
      markTreeReadStarted();
      return new Promise<DescribeNode>(() => {});
    };
    const calls: string[] = [];

    const pending = run(calls, controller.signal);
    await treeReadStarted;
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    const result = await pending;

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it.each(["tap", "long-press"] as const)(
    "keeps a raw-coordinate %s full-tree-gated when the hierarchy source is down",
    async (kind) => {
      vi.useFakeTimers();
      const source = new Error("native devtools is unavailable (service down)");
      let treeReads = 0;
      currentTree = () => {
        treeReads++;
        return Promise.reject(source);
      };
      await writeFlow(
        `coordinate-outage-${kind}`,
        kind === "tap" ? [{ kind, x: 0.3, y: 0.7 }] : [{ kind, x: 0.3, y: 0.7, duration: 500 }]
      );
      const calls: string[] = [];

      const pending = run(calls, undefined, `coordinate-outage-${kind}`);
      await vi.waitFor(() => expect(treeReads).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result.steps).toMatchObject([
        {
          kind,
          status: "error",
          reason: "native devtools is unavailable (service down)",
        },
      ]);
      expect(calls.filter((id) => id.startsWith("gesture-"))).toEqual([]);
      expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    }
  );

  it("withholds the tap until the pixels stop changing", async () => {
    // The tree is settled, but pixels keep moving for one more read (a modal
    // still sliding out) before going still.
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255])) // prev
      .mockResolvedValueOnce(solid([0, 0, 0])) // motion → keep waiting
      .mockResolvedValue(solid([0, 0, 0])); // matches prev → settled

    const calls: string[] = [];
    const result = await run(calls);

    expect(result.ok).toBe(true);
    expect(calls).toContain("gesture-tap");
    // prev + the two reads it took to see a matching pair.
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(3);
  });

  it("captures a snapshot only after the real combined settle observes pixels stop moving", async () => {
    const shotPath = path.join(tmpDir, "snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockResolvedValueOnce(solid([0, 0, 0]))
      .mockResolvedValue(solid([0, 0, 0]));
    let capturesAtSnapshot = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          capturesAtSnapshot = vi.mocked(capturePixels).mock.calls.length;
          return {
            image: {
              __argentArtifact: true,
              id: "current-snapshot",
              hostPath: shotPath,
              mimeType: "image/png",
            },
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    const env = {
      registry,
      ctx: { artifacts: new ArtifactStore() },
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const result = await runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "home",
      maxMismatch: 0.5,
      updateBaselines: true,
    });

    expect(result.status).toBe("pass");
    expect(capturesAtSnapshot).toBe(3);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(3);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({ includeImageInContext: false, scale: 1 })
    );
  });

  it("taps immediately when pixels can't be read (soft skip, no wait)", async () => {
    vi.mocked(capturePixels).mockResolvedValue(undefined);

    const calls: string[] = [];
    const result = await run(calls);

    expect(result.ok).toBe(true);
    expect(calls).toContain("gesture-tap");
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("dispatches no tap when the run is cancelled during an in-flight capture", async () => {
    const controller = new AbortController();
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255])) // prev
      .mockImplementationOnce(() => new Promise(() => {})); // capture never resolves

    const calls: string[] = [];
    const pending = run(calls, controller.signal);
    await vi.waitFor(() => expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2));
    controller.abort();
    const result = await pending;

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
  });

  it("restarts settling and resolves the selector from the final tree", async () => {
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const transient = screen([
      n({ label: "Go", frame: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 } }),
    ]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let phase: "before" | "transient" | "after" = "before";
    currentTree = () => {
      if (phase === "before") return before;
      if (phase === "transient") {
        phase = "after";
        return transient;
      }
      return after;
    };
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockImplementationOnce(async () => {
        phase = "transient";
        return solid([255, 255, 255]);
      })
      // The restarted settle may degrade to tree-only when capture is absent.
      .mockResolvedValue(undefined);

    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const tool = createRunFlowTool(registry);
    const result = await tool.execute({}, { name: "tap-go", project_root: tmpDir, device: DEVICE });

    expect("steps" in result && result.ok).toBe(true);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.7, y: 0.7 })
    );
  });

  it("revalidates a moved tree after a later capture hangs", async () => {
    vi.useFakeTimers();
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let moved = false;
    currentTree = () => (moved ? after : before);
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockImplementationOnce(() => {
        moved = true;
        return new Promise(() => {});
      })
      .mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env);
    await vi.advanceTimersByTimeAsync(3_000);
    const settled = await pending;

    expect(settled).toMatchObject({ tree: after, converged: false, treeFresh: true });
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(3);
  });

  it("revalidates when a slow first capture resolves unavailable after the tree moves", async () => {
    vi.useFakeTimers();
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let moved = false;
    currentTree = () => (moved ? after : before);
    vi.mocked(capturePixels)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              moved = true;
              resolve(undefined);
            }, 1_000);
          })
      )
      .mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env);
    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await pending;

    expect(settled).toMatchObject({ tree: after, converged: true, treeFresh: true });
    // Once unavailability is known, the restarted settle is deliberately
    // tree-only; it must not keep probing a backend that already opted out.
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("revalidates a moved tree when a later capture becomes unavailable", async () => {
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let moved = false;
    currentTree = () => (moved ? after : before);
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockImplementationOnce(async () => {
        moved = true;
        return undefined;
      });

    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const tool = createRunFlowTool(registry);
    const result = await tool.execute({}, { name: "tap-go", project_root: tmpDir, device: DEVICE });

    expect("steps" in result && result.ok).toBe(true);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.7, y: 0.7 })
    );
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("errors a selector gesture when the tree source goes dark mid-action", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return reads <= 2 ? visible : new Promise(() => {});
    };
    vi.mocked(capturePixels).mockResolvedValue(undefined);
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "tap",
      selector: { text: "Go", loose: true },
    });
    const rejected = expect(pending).rejects.toThrow(
      /timed out reading the UI tree while settling/
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(calls).not.toContain("gesture-tap");
  });

  it("bounds a hung capture by the caller's absolute deadline", async () => {
    vi.useFakeTimers();
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let moved = false;
    currentTree = () => (moved ? after : before);
    vi.mocked(capturePixels).mockImplementation(() => {
      moved = true;
      return new Promise(() => {});
    });
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      tree: after,
      converged: false,
      treeFresh: true,
    });
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("returns a fresh moved tree when pixels keep moving for the full pixel budget", async () => {
    vi.useFakeTimers();
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    const after = screen([n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } })]);
    let moved = false;
    currentTree = () => (moved ? after : before);
    let white = false;
    vi.mocked(capturePixels).mockImplementation(async () => {
      moved = true;
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 2_500 });
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(pending).resolves.toMatchObject({
      tree: after,
      converged: false,
      treeFresh: true,
    });
    expect(vi.mocked(capturePixels).mock.calls.length).toBeGreaterThan(2);
  });

  it("keeps the latest successful tree fresh when tree-only settling times out", async () => {
    vi.useFakeTimers();
    let reads = 0;
    currentTree = () =>
      screen([
        n({
          label: `tick ${++reads}`,
          frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
        }),
      ]);
    vi.mocked(capturePixels).mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, {
      mode: "tree-only",
      absoluteDeadline: Date.now() + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = await pending;

    expect(settled).toMatchObject({ converged: false, treeFresh: true });
    expect(settled?.tree.children[0]?.label).toBe(`tick ${reads}`);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it.each(["tap", "long-press"] as const)(
    "waits for visual settling before a raw-coordinate %s",
    async (kind) => {
      await writeFlow(
        `coordinate-${kind}`,
        kind === "tap" ? [{ kind, x: 0.3, y: 0.7 }] : [{ kind, x: 0.3, y: 0.7, duration: 500 }]
      );
      vi.mocked(capturePixels)
        .mockResolvedValueOnce(solid([255, 255, 255]))
        .mockResolvedValueOnce(solid([0, 0, 0]))
        .mockResolvedValue(solid([0, 0, 0]));
      let capturesAtGesture = 0;
      const calls: string[] = [];

      const result = await run(calls, undefined, `coordinate-${kind}`, (id) => {
        if (id.startsWith("gesture-")) {
          capturesAtGesture = vi.mocked(capturePixels).mock.calls.length;
        }
      });

      expect(result.ok).toBe(true);
      expect(capturesAtGesture).toBe(3);
    }
  );

  it.each(["tap", "long-press"] as const)(
    "dispatches a raw-coordinate %s when pixels settle but the final tree read hangs",
    async (kind) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      let reads = 0;
      currentTree = () => {
        reads++;
        return reads <= 2 ? visible : new Promise<DescribeNode>(() => {});
      };
      vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
      const calls: string[] = [];
      const registry = mockRegistry(calls);
      const env = {
        registry,
        device: { platform: "ios", id: DEVICE },
      } as unknown as ActionEnv;

      const pending = runDirective(
        env,
        kind === "tap" ? { kind, x: 0.3, y: 0.7 } : { kind, x: 0.3, y: 0.7, duration: 500 }
      );
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;

      // The literal coordinates consult no selector: settled pixels are proof
      // enough, and the missing revalidation read must not fail the step.
      expect(result.ok).toBe(true);
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      if (kind === "tap") {
        expect(registry.invokeTool).toHaveBeenCalledWith(
          "gesture-tap",
          expect.objectContaining({ x: 0.3, y: 0.7 })
        );
      }
    }
  );

  it("retries a raw-coordinate tap when revalidation misses once and a later settle succeeds", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // The first post-pixel revalidation read hangs (a slow uiautomator
      // dump); every read after it succeeds again.
      return reads === 3 ? new Promise<DescribeNode>(() => {}) : visible;
    };
    vi.mocked(capturePixels).mockImplementation(() => new Promise(() => {}));
    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, { kind: "tap", x: 0.3, y: 0.7 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.3, y: 0.7 })
    );
  });

  it.each(["tap", "long-press"] as const)(
    "dispatches a raw-coordinate %s best-effort when an endless animation outlasts the deadline",
    async (kind) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      let reads = 0;
      currentTree = () => {
        reads++;
        // Every post-pixel revalidation read (each settle's third) outlives
        // its budget, so no settle ever ends tree-fresh…
        return reads % 3 === 0 ? new Promise<DescribeNode>(() => {}) : visible;
      };
      // …and a perpetual animation keeps the pixel pairs from ever matching.
      let white = false;
      vi.mocked(capturePixels).mockImplementation(async () => {
        white = !white;
        return solid(white ? [255, 255, 255] : [0, 0, 0]);
      });
      const calls: string[] = [];
      let dispatchedAt = -1;
      const registry = mockRegistry(calls, undefined, (id) => {
        if (id.startsWith("gesture-")) dispatchedAt = Date.now();
      });
      const env = {
        registry,
        device: { platform: "ios", id: DEVICE },
      } as unknown as ActionEnv;

      const start = Date.now();
      const pending = runDirective(
        env,
        kind === "tap" ? { kind, x: 0.3, y: 0.7 } : { kind, x: 0.3, y: 0.7, duration: 500 }
      );
      await vi.advanceTimersByTimeAsync(9_000);
      const result = await pending;

      // A settle that never becomes usable must not fail the step: at deadline
      // exhaustion the gesture dispatches anyway at the literal point.
      expect(result.ok).toBe(true);
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      // …and only after the deadline gave settling every chance first.
      expect(dispatchedAt - start).toBeGreaterThanOrEqual(7_500);
      if (kind === "tap") {
        expect(registry.invokeTool).toHaveBeenCalledWith(
          "gesture-tap",
          expect.objectContaining({ x: 0.3, y: 0.7 })
        );
      }
    }
  );

  it.each(["tap", "type"] as const)(
    "resolves a selector %s from the last settled tree when no settle ends tree-fresh",
    async (kind) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      let dispatched = false;
      let reads = 0;
      currentTree = () => {
        reads++;
        // Until the gesture fires, every settle's post-pixel revalidation
        // read (its third) hangs, so no settle ends tree-fresh.
        if (dispatched) return visible;
        return reads % 3 === 0 ? new Promise<DescribeNode>(() => {}) : visible;
      };
      vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
      const calls: string[] = [];
      const registry = mockRegistry(calls, undefined, (id) => {
        if (id === "gesture-tap") dispatched = true;
      });
      const env = {
        registry,
        device: { platform: "ios", id: DEVICE },
      } as unknown as ActionEnv;

      const pending = runDirective(
        env,
        kind === "tap"
          ? { kind, selector: { text: "Go", loose: true } }
          : { kind, into: { text: "Go", loose: true }, text: "hi" }
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;

      // At deadline exhaustion the selector resolves best-effort from the
      // last valid settled tree instead of failing on the slow settles.
      expect(result.ok).toBe(true);
      expect(registry.invokeTool).toHaveBeenCalledWith(
        "gesture-tap",
        expect.objectContaining({ x: 0.5, y: 0.5 })
      );
      if (kind === "type") expect(calls).toContain("keyboard");
    }
  );

  it("fails a selector tap honestly when the element is absent from the stale trees", async () => {
    vi.useFakeTimers();
    const noGo = screen([
      n({ label: "Other", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return reads % 3 === 0 ? new Promise<DescribeNode>(() => {}) : noGo;
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, { kind: "tap", selector: { text: "Go", loose: true } });
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await pending;

    // The stale-tree fallback finds nothing: the element is genuinely absent,
    // so the ordinary not-found reason stands.
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no visible element matched selector");
    expect(calls).not.toContain("gesture-tap");
  });

  it("prefers a later fresh resolution over the stale-tree fallback", async () => {
    vi.useFakeTimers();
    const staleAt = screen([
      n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }),
    ]);
    const freshAt = screen([
      n({ label: "Go", frame: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Settle 1's post-pixel read (read 3) hangs, leaving a stale result at
      // the old frame; settle 2 completes fresh at the new one.
      if (reads === 3) return new Promise<DescribeNode>(() => {});
      return reads < 3 ? staleAt : freshAt;
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const env = { registry, device: { platform: "ios", id: DEVICE } } as unknown as ActionEnv;

    const pending = runDirective(env, { kind: "tap", selector: { text: "Go", loose: true } });
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    // Dispatched at the fresh frame, not the stale round's remembered one.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.7, y: 0.7 })
    );
  });

  it("does not scroll through a compositor transition", async () => {
    await writeFlow("scroll", [
      { kind: "scroll-to", target: { text: "Target" }, direction: "down" },
    ]);
    const before = screen([
      n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
    ]);
    const after = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
    ]);
    let scrolled = false;
    currentTree = () => (scrolled ? after : before);
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockResolvedValueOnce(solid([0, 0, 0]))
      .mockResolvedValueOnce(solid([0, 0, 0]))
      .mockResolvedValue(undefined);
    let capturesAtSwipe = 0;
    const calls: string[] = [];

    const result = await run(calls, undefined, "scroll", (id) => {
      if (id === "gesture-swipe") {
        capturesAtSwipe = vi.mocked(capturePixels).mock.calls.length;
        scrolled = true;
      }
    });

    expect(result.ok).toBe(true);
    expect(capturesAtSwipe).toBe(3);
  });

  it("captures pixels only before the first increment of a multi-iteration scroll", async () => {
    await writeFlow("multi-scroll", [
      { kind: "scroll-to", target: { text: "Target" }, direction: "down" },
    ]);
    const trees = [
      screen([n({ label: "Before", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      screen([
        n({ label: "After one", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ label: "Target", frame: { x: 0.1, y: 0.85, width: 0.8, height: 0.15 } }),
      ]),
      screen([n({ label: "Target", frame: { x: 0.1, y: 0.6, width: 0.8, height: 0.15 } })]),
    ];
    let scrollPosition = 0;
    currentTree = () => trees[scrollPosition]!;
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const capturesAtSwipe: number[] = [];
    const calls: string[] = [];

    const result = await run(calls, undefined, "multi-scroll", (id) => {
      if (id === "gesture-swipe") {
        capturesAtSwipe.push(vi.mocked(capturePixels).mock.calls.length);
        scrollPosition++;
      }
    });

    expect(result.ok).toBe(true);
    expect(capturesAtSwipe).toEqual([2, 2]);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the pixel timeout for a persistent animator while scrolling", async () => {
    vi.useFakeTimers();
    const trees = [
      screen([n({ label: "Before", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      screen([
        n({ label: "After one", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ label: "Target", frame: { x: 0.1, y: 0.85, width: 0.8, height: 0.15 } }),
      ]),
      screen([n({ label: "Target", frame: { x: 0.1, y: 0.6, width: 0.8, height: 0.15 } })]),
    ];
    let scrollPosition = 0;
    let white = false;
    currentTree = () => trees[scrollPosition]!;
    vi.mocked(capturePixels).mockImplementation(async () => {
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const capturesAtSwipe: number[] = [];
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls, undefined, (id) => {
        if (id === "gesture-swipe") {
          capturesAtSwipe.push(vi.mocked(capturePixels).mock.calls.length);
          scrollPosition++;
        }
      }),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "scroll-to",
      target: { text: "Target" },
      direction: "down",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(capturesAtSwipe).toHaveLength(2);
    expect(capturesAtSwipe[0]).toBeGreaterThan(2);
    expect(capturesAtSwipe[1]).toBe(capturesAtSwipe[0]);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(capturesAtSwipe[0]!);
  });

  it("leaves at most one orphaned capture when the first scroll settle hangs", async () => {
    vi.useFakeTimers();
    const trees = [
      screen([n({ label: "Before", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      screen([
        n({ label: "After one", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ label: "Target", frame: { x: 0.1, y: 0.85, width: 0.8, height: 0.15 } }),
      ]),
      screen([n({ label: "Target", frame: { x: 0.1, y: 0.6, width: 0.8, height: 0.15 } })]),
    ];
    let scrollPosition = 0;
    currentTree = () => trees[scrollPosition]!;
    vi.mocked(capturePixels).mockImplementation(() => new Promise(() => {}));
    let swipes = 0;
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls, undefined, (id) => {
        if (id === "gesture-swipe") {
          swipes++;
          scrollPosition++;
        }
      }),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "scroll-to",
      target: { text: "Target" },
      direction: "down",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(swipes).toBe(2);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("retries the first scroll round when tree revalidation misses instead of failing", async () => {
    vi.useFakeTimers();
    // The target is fully on screen the whole time — only the first combined
    // settle's hung capture and hung revalidation read stand in the way.
    const tree = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return reads === 3 ? new Promise<DescribeNode>(() => {}) : tree;
    };
    vi.mocked(capturePixels).mockImplementation(() => new Promise(() => {}));
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "scroll-to",
      target: { text: "Target" },
      direction: "down",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    // The skipped round scrolls nothing, and the next (tree-only) round
    // resolves the target — one slow read is not a step failure.
    expect(result.ok).toBe(true);
    expect(calls).not.toContain("gesture-swipe");
    // The pixel probe still runs only in the first (combined) round.
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("downgrades settled pixels when a restarted tree phase never re-converges", async () => {
    vi.useFakeTimers();
    const before = screen([n({ label: "Go", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })]);
    let moved = false;
    let ticks = 0;
    currentTree = () => {
      if (!moved) return before;
      ticks++;
      return screen([
        n({ label: `tick ${ticks}`, frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }),
      ]);
    };
    vi.mocked(capturePixels)
      .mockResolvedValueOnce(solid([255, 255, 255]))
      .mockImplementationOnce(async () => {
        moved = true;
        return solid([255, 255, 255]);
      })
      .mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env);
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await pending;

    // The pixel pair matched BEFORE the tree moved, so "settled" would
    // describe the pre-restart screen — it must come back downgraded.
    expect(settled).toMatchObject({ converged: false, treeFresh: true, visual: "skipped" });
  });

  it("restarts from the stable fingerprint when the post-pixel revalidation read blips", async () => {
    const stable = screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    let treeReads = 0;
    const capturesAtRead: number[] = [];
    currentTree = () => {
      treeReads++;
      capturesAtRead.push(vi.mocked(capturePixels).mock.calls.length);
      // Reads 1–2 converge the tree phase and the pixel pair runs in between,
      // so read 3 is exactly the mandatory post-pixel revalidation read. A
      // mid-navigation describe blip lands on it once; every later read
      // succeeds with the same stable tree.
      return treeReads === 3 ? Promise.reject(new Error("transient describe blip")) : stable;
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    let readsAtTap = 0;
    let capturesAtTap = 0;
    const calls: string[] = [];
    const registry = mockRegistry(calls, undefined, (id) => {
      if (id === "gesture-tap") {
        readsAtTap = treeReads;
        capturesAtTap = vi.mocked(capturePixels).mock.calls.length;
      }
    });
    const tool = createRunFlowTool(registry);

    const result = await tool.execute({}, { name: "tap-go", project_root: tmpDir, device: DEVICE });

    // One blip on the revalidation read is a transient gap, not a tree-source
    // outage: the step passes, dispatching at the final tree's frame, and the
    // error string surfaces nowhere in the report.
    if (!("steps" in result))
      throw new Error(`expected a run result, got notice: ${result.notice}`);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass"]);
    expect(result.steps[0].reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("transient describe blip");
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.5 })
    );
    // The restart is seeded with the pre-blip stable fingerprint: read 4
    // matches that seed, so the restarted tree phase converges on that single
    // read and the settle finishes at read 5 (a restart that dropped the seed
    // would need two matching post-blip reads — six in total).
    expect(readsAtTap).toBe(5);
    // And the restart re-proves visual quiet instead of trusting the pre-blip
    // pair: two captures before the failing read, two more between the
    // restart's convergence (read 4) and the final read (read 5).
    expect(capturesAtRead).toEqual([0, 0, 2, 2, 4]);
    expect(capturesAtTap).toBe(4);
  });

  it("returns a fully settled result after a transient error on the revalidation read", async () => {
    const stable = screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    let treeReads = 0;
    currentTree = () => {
      treeReads++;
      return treeReads === 3 ? Promise.reject(new Error("transient describe blip")) : stable;
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const settled = await settleTree(env);

    // The blip forces a restart (the downgraded `settled` must not leak), but
    // the re-seeded phase re-converges and the re-run pixel pair restores
    // `settled` — nothing about the error reads as an outage or best-effort.
    expect(settled).toEqual({ tree: stable, converged: true, treeFresh: true, visual: "settled" });
    expect(treeReads).toBe(5);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(4);
  });

  it("writes a snapshot baseline when pixels settle but the final tree read hangs", async () => {
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    let reads = 0;
    currentTree = () => {
      reads++;
      return reads <= 2
        ? screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })])
        : new Promise<DescribeNode>(() => {});
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "current-snapshot",
              hostPath: shotPath,
              mimeType: "image/png",
            },
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    const env = {
      registry,
      ctx: { artifacts: new ArtifactStore() },
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "home",
      maxMismatch: 0.5,
      updateBaselines: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    // Pixels settled, only the confirming tree read is missing: the settler
    // retries for freshness on the action deadline, then accepts the
    // stale-but-settled screen — the comparison proceeds undegraded.
    expect(result.status).toBe("pass");
    expect(result.reason).toContain("baseline written");
    expect(result.reason).not.toContain("degraded");
    await expect(
      fs.access(path.join(tmpDir, "__baselines__", "checkout", "home__ios-390x844.png"))
    ).resolves.toBeUndefined();
  });
});

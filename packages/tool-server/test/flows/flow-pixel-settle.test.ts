import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
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

vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind: vi.fn(async () => "mobile"),
}));

import { capturePixels, PIXEL_SETTLE_TIMEOUT_MS } from "../../src/tools/flows/flow-pixels";
import { getSimulatorRuntimeKind } from "../../src/utils/ios-devices";
import { FIRST_FRAME_WAIT_MS } from "../../src/utils/simulator-client";
import {
  COMBINED_HARD_TIMEOUT_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
  runDirective,
  settleTree,
  waitForFrameResult,
} from "../../src/tools/flows/flow-actions";
import {
  FlowTreeSettleTimeoutError,
  FlowTreeSourceUnavailableError,
} from "../../src/tools/flows/flow-errors";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;
const mockGetSimulatorRuntimeKind = vi.mocked(getSimulatorRuntimeKind);

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
  mockGetSimulatorRuntimeKind.mockReset().mockResolvedValue("mobile");
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

  it("bounds a never-resolving initial tree read without fabricating a source outage", async () => {
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
    const caught = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await caught;
    expect(err).toBeInstanceOf(FlowTreeSettleTimeoutError);
    expect(err).toMatchObject({ message: "timed out reading the UI tree while settling" });
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("bounds a hung deadline-less tree read at the shared 7.5s action budget", async () => {
    vi.useFakeTimers();
    currentTree = () => new Promise(() => {});
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let rejectedAt = -1;
    const caught = settleTree(env, { mode: "tree-only" }).catch((err: unknown) => {
      rejectedAt = Date.now();
      return err;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    const err = await caught;
    expect(err).toBeInstanceOf(FlowTreeSettleTimeoutError);
    // The unowned fallback matches DEFAULT_ACTION_TIMEOUT_MS, so the hung-read
    // cliff sits at the same 7.5s as every deadline-owning caller's budget.
    expect(rejectedAt - startedAt).toBe(7_500);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("does not start another tree read after polling reaches its phase deadline", async () => {
    vi.useFakeTimers();
    const source = new Error("native devtools is unavailable (service down)");
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads === 1) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(source), 2_900);
        });
      }
      return new Promise(() => {});
    };
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let rejectedAt = -1;
    const caught = settleTree(env).catch((err: unknown) => {
      rejectedAt = Date.now();
      return err;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await caught;

    expect(err).toBeInstanceOf(FlowTreeSourceUnavailableError);
    expect(reads).toBe(1);
    expect(rejectedAt - startedAt).toBe(3_000);
  });

  it.each(["selector", "coordinates"] as const)(
    "uses a successful tree read beyond the 5s combined cap for %s taps",
    async (target) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      currentTree = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(visible), 6_000);
        });
      const calls: string[] = [];
      const registry = mockRegistry(calls);
      const env = {
        registry,
        device: { platform: "ios", id: DEVICE },
      } as unknown as ActionEnv;

      const pending = runDirective(
        env,
        target === "selector"
          ? { kind: "tap", selector: { text: "Go", loose: true } }
          : { kind: "tap", x: 0.3, y: 0.7 }
      );
      const resolved = expect(pending).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(6_500);

      await resolved;
      expect(registry.invokeTool).toHaveBeenCalledWith(
        "gesture-tap",
        expect.objectContaining(target === "selector" ? { x: 0.5, y: 0.5 } : { x: 0.3, y: 0.7 })
      );
      expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    }
  );

  it("reports a slow successful tree read as snapshot degradation, not an outage fallback", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    currentTree = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(visible), 3_500);
      });
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));

    const shotPath = path.join(tmpDir, "slow-tree-snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "slow-tree-current",
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
      name: "slow-tree",
      maxMismatch: 0.5,
      updateBaselines: true,
    });
    const resolved = expect(pending).resolves.toMatchObject({ status: "pass" });
    await vi.advanceTimersByTimeAsync(4_000);
    await resolved;
    const result = await pending;

    expect(result.reason).toBe(
      "baseline written (slow-tree__ios-390x844.png); " +
        "capture is best-effort/degraded because visual settling timed out"
    );
    // The successful late tree is observed; no fabricated outage sends the
    // snapshot through its independent pixels-only fallback.
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

  it("settles a first-frame-boundary capture plus completion overhead inside the action deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(capturePixels)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(solid([255, 255, 255])), FIRST_FRAME_WAIT_MS + 250);
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(solid([255, 255, 255])), 100);
          })
      );
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 7_500 });
    await vi.advanceTimersByTimeAsync(7_000);
    const settled = await pending;

    expect(settled).toMatchObject({
      converged: true,
      treeFresh: true,
      visual: "settled",
    });
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("settles a first-frame-boundary capture under the deadline-less combined hard budget", async () => {
    vi.useFakeTimers();
    // The one COMBINED settle that runs with NO caller deadline is scroll-to's
    // round-0 settle, so COMBINED_HARD_TIMEOUT_MS is the only bound here.
    // This is exactly the regime FIRST_PIXEL_CAPTURE_TIMEOUT_MS exists for: a
    // cold simulator-server stream spending nearly FIRST_FRAME_WAIT_MS on its
    // first frame, followed by a matching warm capture. Collapsing the hard
    // budget to the 3s tree window alone (dropping the pixel term) would cut
    // that first capture at ~2.75s: the phase would end "timed-out" after one
    // launched-and-expired capture and the settle would degrade to
    // converged: false instead of proving visual stillness.
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return visible;
    };
    vi.mocked(capturePixels)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(solid([255, 255, 255])), FIRST_FRAME_WAIT_MS + 250);
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(solid([255, 255, 255])), 100);
          })
      );
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env);
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    expect(settled).toEqual({
      tree: visible,
      converged: true,
      treeFresh: true,
      visual: "settled",
    });
    // The converging pair plus exactly the one post-pixel revalidation read;
    // both captures completed — the slow first one was never cut short.
    expect(reads).toBe(3);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("sizes the deadline-less combined hard budget for the first-frame-aware pixel window", () => {
    // hardDeadline falls back to COMBINED_HARD_TIMEOUT_MS only when the caller
    // supplies no absoluteDeadline (scroll-to's round-0 combined settle). Pin
    // the pixel term so the budget can only lose its slow-first-frame headroom
    // deliberately: the 3s tree window, the full first-frame-aware pixel
    // window, and the 250ms final-read reserve.
    expect(COMBINED_HARD_TIMEOUT_MS).toBe(3_000 + PIXEL_SETTLE_TIMEOUT_MS + 250);
  });

  it("gives the post-pixel read the ordinary phase deadline after a fast pixel phase", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Every read is healthy at ordinary Android-uiautomator-like latency:
      // 400ms — well under the phase deadline, but well over the 250ms
      // final-read reserve.
      return new Promise((resolve) => {
        setTimeout(() => resolve(visible), 400);
      });
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 7_500 });
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    // Pins the finalTreeDeadline two-arm choice: a fast pixel phase (matching
    // pair on the second capture, finished by ~t=1.2s) leaves the ordinary
    // phase deadline for the mandatory post-pixel revalidation read, so an
    // ordinary-latency 400ms read completes and the settle stays fully fresh.
    // Cutting that read at the 250ms reserve instead would turn this everyday
    // settle into { converged: false, treeFresh: false } — a tree
    // `waitForFrameResult` refuses to resolve a selector from.
    expect(settled).toEqual({
      tree: visible,
      converged: true,
      treeFresh: true,
      visual: "settled",
    });
    // Two converging reads plus exactly the one revalidation read; the pixel
    // pair matched on its second capture.
    expect(reads).toBe(3);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
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

  it("settles combined mode tree-only on Vega without probing the capture backend", async () => {
    const env = {
      registry: mockRegistry([]),
      device: { platform: "vega", id: "vega-serial" },
    } as unknown as ActionEnv;

    const settled = await settleTree(env);

    // No backend exists to probe: the settle converges on the tree alone with
    // visual "skipped" — not the probed-and-failed "unavailable".
    expect(settled).toMatchObject({ converged: true, treeFresh: true, visual: "skipped" });
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("settles combined mode tree-only on tvOS without probing simulator-server pixels", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue("tv");
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const settled = await settleTree(env);

    expect(settled).toMatchObject({
      converged: true,
      treeFresh: true,
      visual: "skipped",
    });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledWith(DEVICE);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("reports an unknown iOS runtime probe as pixel settling unavailable", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const settled = await settleTree(env);

    expect(settled).toMatchObject({
      converged: true,
      treeFresh: true,
      visual: "unavailable",
    });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("does not re-probe unknown pixel support within one selector wait", async () => {
    vi.useFakeTimers();
    mockGetSimulatorRuntimeKind.mockResolvedValueOnce(undefined).mockResolvedValue("mobile");
    vi.mocked(capturePixels).mockResolvedValue(undefined);
    currentTree = () => screen([]);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const missing = waitForFrameResult(env, { text: "Go", loose: true });
    await vi.advanceTimersByTimeAsync(7_500);

    await expect(missing).resolves.toMatchObject({ frame: undefined });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();

    currentTree = () =>
      screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    const recovered = waitForFrameResult(env, { text: "Go", loose: true });
    await vi.advanceTimersByTimeAsync(250);

    await expect(recovered).resolves.toMatchObject({
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("keeps visual unavailability paired with a selector found by the forced tree-only round", async () => {
    vi.useFakeTimers();
    mockGetSimulatorRuntimeKind.mockResolvedValueOnce(undefined).mockResolvedValue("mobile");
    const absent = screen([]);
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    // The first combined settle consumes three reads: its stable pair and the
    // mandatory post-probe revalidation. Reveal the selector only to the next,
    // forced tree-only settle.
    currentTree = () => (++reads <= 3 ? absent : visible);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = waitForFrameResult(env, { text: "Go", loose: true });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      settle: {
        converged: true,
        treeFresh: true,
        visual: "unavailable",
      },
    });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("retries combined settling after a non-converged unavailable result", async () => {
    vi.useFakeTimers();
    const absent = screen([]);
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    const revalidationFailure = new Error("transient post-pixel tree failure");
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads <= 2) return absent;
      if (reads === 3) return Promise.reject(revalidationFailure);
      return visible;
    };
    // The first unavailable capture crosses the combined phase and its final
    // tree read fails, producing converged:false/treeFresh:false. The retry
    // must remain combined and therefore perform the second capture.
    vi.mocked(capturePixels)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(undefined), 5_000);
          })
      )
      .mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = waitForFrameResult(env, { text: "Go", loose: true });
    await vi.advanceTimersByTimeAsync(6_500);

    await expect(pending).resolves.toMatchObject({
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      settle: {
        converged: true,
        treeFresh: true,
        visual: "unavailable",
      },
    });
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("aborts while the iOS runtime-kind probe is pending without dispatching", async () => {
    const controller = new AbortController();
    mockGetSimulatorRuntimeKind.mockImplementation(() => new Promise(() => {}));
    const calls: string[] = [];
    const env = {
      registry: mockRegistry(calls, controller.signal),
      device: { platform: "ios", id: DEVICE },
      signal: controller.signal,
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "tap",
      selector: { text: "Go", loose: true },
    });
    await vi.waitFor(() => expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, aborted: true, reason: "run aborted" });
    expect(calls).not.toContain("gesture-tap");
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("dispatches best-effort when a pending iOS runtime-kind probe outlives the action deadline", async () => {
    vi.useFakeTimers();
    mockGetSimulatorRuntimeKind.mockImplementation(() => new Promise(() => {}));
    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "tap",
      selector: { text: "Go", loose: true },
    });
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_500);
    await resolved;

    // The hung probe consumes the settle's whole remaining budget
    // unrevalidated, so the one round that fits comes back non-fresh — but
    // best-effort, never an error. At deadline exhaustion the selector
    // resolves from the last valid settled tree and the gesture dispatches: a
    // stuck capability lookup must not fail a step whose tree source stayed
    // healthy, and no capture ever gated it.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.5 })
    );
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("marks the tree unsafe when the awaited iOS runtime-kind probe consumes the deadline", async () => {
    vi.useFakeTimers();
    mockGetSimulatorRuntimeKind.mockImplementation(() => new Promise(() => {}));
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = await pending;

    // Unlike a budget consumed by the read itself, real time passed while the
    // probe hung: the screen may have moved with no revalidating read, so the
    // converged tree comes back explicitly not-fresh — acting callers must
    // reject it, but it remains a best-effort result rather than an error.
    expect(settled).toMatchObject({ converged: false, treeFresh: false, visual: "skipped" });
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("returns the just-converged tree when a slow read consumes the deadline on a probe-free platform", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads === 1) return visible;
      // The matching second read is healthy but slow: created before
      // settleWithin's timeout for the same instant, its resolution wins the
      // race, delivering the converged tree with the deadline already spent.
      return new Promise((resolve) => {
        setTimeout(() => resolve(visible), 750);
      });
    };
    const env = {
      registry: mockRegistry([]),
      device: { platform: "android", id: "emulator-5554" },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = await pending;

    // Android resolves pixel support synchronously — there is no probe whose
    // timeout the settle could be reporting. Zero remaining budget just means
    // the pixel phase never starts: the tree that converged an instant ago is
    // still current and comes back usable for selector coordinates.
    expect(settled).toEqual({
      tree: visible,
      converged: false,
      treeFresh: true,
      visual: "skipped",
    });
    expect(reads).toBe(2);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("marks the carried tree unsafe when a later tree read outlives the read budget", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads === 1) return visible;
      // The second read hangs past the whole 7.5s read budget — an Android
      // hierarchy source whose own budgets (getHierarchy 15s, a uiautomator
      // dump 20s) happily let a read outlive our cliff.
      return new Promise<DescribeNode>(() => {});
    };
    const env = {
      registry: mockRegistry([]),
      device: { platform: "android", id: "emulator-5554" },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let settledAt = -1;
    const pending = settleTree(env).then((result) => {
      settledAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    // The returned tree is the t=0 read — up to the full read budget old, and
    // no second read ever confirmed it. Unlike the delivered slow read above,
    // real unrevalidated time passed while the hung read was awaited, so the
    // carried tree comes back explicitly not-fresh: best-effort for
    // diagnostics, rejected by acting callers (scroll-to's stale-round skip).
    expect(settled).toEqual({
      tree: visible,
      converged: false,
      treeFresh: false,
      visual: "skipped",
    });
    expect(settledAt - startedAt).toBe(7_500);
    expect(reads).toBe(2);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("skips the pixel phase when the tree converges inside the final-read reserve", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return new Promise((resolve) => {
        setTimeout(() => resolve(visible), 400);
      });
    };
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    // Two healthy 400ms reads converge at t=1050 — within the 250ms
    // final-read reserve of the 1150ms deadline. The capability probe still
    // resolves in time (asserted below), but the pixel deadline is already
    // behind us, so the first capture is never launched.
    const pending = settleTree(env, { absoluteDeadline: Date.now() + 1_150 });
    await vi.advanceTimersByTimeAsync(1_150);
    const settled = await pending;

    // A phase that never ran is "skipped", never "timed-out": no capture
    // backend was consulted, zero time passed since the converged pair, and
    // no revalidation read is owed — the tree stays fresh and usable.
    expect(settled).toEqual({
      tree: visible,
      converged: false,
      treeFresh: true,
      visual: "skipped",
    });
    // The probe ran and resolved, so this drives the capture branch, not the
    // probe's own not-attempted path — and only the two converging reads were
    // issued, with no third read spent on an unowed revalidation.
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("marks the tree unsafe when a slow resolving iOS probe eats the pixel window", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      return visible;
    };
    // A cold `getSimulatorRuntimeKind` is a real `xcrun simctl` round trip: it
    // RESOLVES "mobile" at t=7300 — inside the 250ms final-read reserve of the
    // 7500ms deadline, so the probe never times out, yet the pixel window
    // (7250ms) is already behind us before a capture could launch.
    mockGetSimulatorRuntimeKind.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("mobile"), 7_050);
        })
    );
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let settledAt = -1;
    const pending = settleTree(env, { absoluteDeadline: startedAt + 7_500 }).then((result) => {
      settledAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    // The pair converged at t=250 and the only thing between it and this
    // return is the awaited probe: 7050ms of unrevalidated time passed while
    // the screen may have moved, exactly the staleness the probe-timeout twin
    // above reports as not-fresh. Resolving just before the deadline instead
    // of just after it cannot flip the verdict — the tree comes back unsafe
    // for acting callers, best-effort, with the never-started pixel phase
    // still "skipped" rather than "timed-out".
    expect(settled).toEqual({
      tree: visible,
      converged: false,
      treeFresh: false,
      visual: "skipped",
    });
    // Returned at the probe's resolution (t=7300), not the deadline (t=7500):
    // this is the resolved-probe arm, not the probe-timeout arm — and no
    // capture was ever launched.
    expect(settledAt - startedAt).toBe(7_300);
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it.each(["tap", "long-press"] as const)(
    "dispatches a raw-coordinate %s when a slow matching read consumes the whole action deadline",
    async (kind) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      let reads = 0;
      currentTree = () => {
        reads++;
        if (reads === 1) return visible;
        // Resolves exactly at the 7.5s action deadline: every read succeeds,
        // the second merely runs long — the emulator scenario where a healthy
        // 7.2s hierarchy read ends with a synchronous parse past the deadline.
        return new Promise((resolve) => {
          setTimeout(() => resolve(visible), 7_250);
        });
      };
      const calls: string[] = [];
      const registry = mockRegistry(calls);
      const env = {
        registry,
        device: { platform: "android", id: "emulator-5554" },
      } as unknown as ActionEnv;

      const pending = runDirective(
        env,
        kind === "tap" ? { kind, x: 0.3, y: 0.7 } : { kind, x: 0.3, y: 0.7, duration: 500 }
      );
      const resolved = expect(pending).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(7_500);
      await resolved;

      // Literal coordinates consult no selector, and the settle is best-effort
      // stabilization, not a precondition: the freshly delivered tree lets the
      // gesture dispatch instead of the step erroring on a lookup that never
      // ran.
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      if (kind === "tap") {
        expect(registry.invokeTool).toHaveBeenCalledWith(
          "gesture-tap",
          expect.objectContaining({ x: 0.3, y: 0.7 })
        );
      }
      expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    }
  );

  it("writes an undegraded Vega snapshot baseline through the real combined settle", async () => {
    const shotPath = path.join(tmpDir, "snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
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
      device: { platform: "vega", id: "vega-serial" },
    } as unknown as ActionEnv;

    const result = await runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "home",
      maxMismatch: 0.5,
      updateBaselines: true,
    });

    // A healthy Vega device has no pixel backend by construction, so the write
    // must carry no best-effort/degraded suffix — assert the whole reason.
    expect(result.status).toBe("pass");
    expect(result.reason).toBe("baseline written (home__vega-390x844.png)");
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
  });

  it("writes an undegraded tvOS snapshot baseline through the architectural pixel skip", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue("tv");
    const shotPath = path.join(tmpDir, "tvos-snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    await fs.writeFile(shotPath, png);
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "tvos-current-snapshot",
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
      name: "tv-home",
      maxMismatch: 0.5,
      updateBaselines: true,
    });

    expect(result.status).toBe("pass");
    expect(result.reason).toBe("baseline written (tv-home__ios-1920x1080.png)");
    expect(result.reason).not.toContain("degraded");
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({ includeImageInContext: false, scale: 1 })
    );
  });

  it("still degrades a snapshot when a resolvable capture backend fails transiently", async () => {
    const shotPath = path.join(tmpDir, "snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    // iOS has a backend, but every capture soft-fails — that IS a degraded
    // capture: nothing proved the pixels stopped.
    vi.mocked(capturePixels).mockResolvedValue(undefined);
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

    const result = await runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "home",
      maxMismatch: 0.5,
      updateBaselines: true,
    });

    expect(result.status).toBe("pass");
    expect(result.reason).toBe(
      "baseline written (home__ios-390x844.png); " +
        "capture is best-effort/degraded because visual settling was unavailable"
    );
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("taps immediately when pixels can't be read (soft skip, no wait)", async () => {
    vi.mocked(capturePixels).mockResolvedValue(undefined);

    const calls: string[] = [];
    const result = await run(calls);

    expect(result.ok).toBe(true);
    expect(calls).toContain("gesture-tap");
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  it("returns the visual verdict from the same settle that resolved a frame", async () => {
    vi.mocked(capturePixels).mockResolvedValue(undefined);
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const resolved = await waitForFrameResult(env, { text: "Go", loose: true });

    expect(resolved).toMatchObject({
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      settle: {
        converged: true,
        treeFresh: true,
        visual: "unavailable",
      },
    });
    // One unavailable capture belongs to the settle that yielded the frame;
    // resolving metadata must not trigger a second settle/capture.
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
  });

  // The two tests below pin the OTHER half of that pairing: what `runSnapshot`
  // must report when the settle handed back with the frame did NOT converge.
  // `snapshotSettleFromResult` only lets `skipped`/`unavailable` keep their own
  // (undegraded / "was unavailable") vocabulary while `converged` holds —
  // everything else is an honest "timed out". Both drive the real
  // settleTree → waitForFrameResult → runSnapshot chain rather than a
  // hand-built SettleResult, because the shapes are ordinary screens: any
  // churning hierarchy (spinner, ticking clock, list still settling) produces
  // them.
  const CROP_ON = { text: "Header", loose: true };
  // Fixed on-screen region for the crop target, so the selector keeps
  // resolving while a sibling churns the fingerprint: on a 100×200 capture the
  // rect is x 25–75, y 50–100 → a 50×50 crop.
  const CROP_FRAME = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
  const cropKey = (name: string): string =>
    `${name}__ios-100x200-crop-${createHash("sha256")
      .update(JSON.stringify(["Header", null, null, null, true]))
      .digest("hex")
      .slice(0, 8)}`;
  /** A real 100×200 PNG — the cropOn path decodes and re-encodes actual pixels. */
  async function writeCropCapture(file: string): Promise<void> {
    const png = new PNG({ width: 100, height: 200 });
    png.data.fill(128);
    await fs.writeFile(file, PNG.sync.write(png));
  }
  function snapshotRegistry(shotPath: string, id: string): Registry {
    return {
      invokeTool: vi.fn(async (toolId: string) => {
        if (toolId === "screenshot") {
          return {
            image: { __argentArtifact: true, id, hostPath: shotPath, mimeType: "image/png" },
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }
  /** The crop target plus a sibling whose label is `tick <n>`. */
  function churningScreen(tick: number): DescribeNode {
    return screen([
      n({ label: "Header", frame: CROP_FRAME }),
      n({ label: `tick ${tick}`, frame: { x: 0, y: 0.9, width: 0.2, height: 0.05 } }),
    ]);
  }

  it("degrades a cropOn baseline whose paired settle skipped pixels without converging", async () => {
    // A tree that never holds still: the sibling label ticks on every read, so
    // the tree phase never finds two matching fingerprints and returns
    // best-effort at its window — `{ converged: false, treeFresh: true,
    // visual: "skipped" }`, since no pixel phase ever started to overwrite the
    // initial verdict. The fresh tree still resolves the (stationary) crop
    // target, so this non-converged settle is what gets paired with the frame.
    // `skipped` reads as "no pixel phase to run" ONLY when the settle
    // converged (a platform with no capture backend); here it means the tree
    // never settled, so the write must carry the timed-out degradation note.
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "churn-snapshot.png");
    await writeCropCapture(shotPath);
    let reads = 0;
    currentTree = () => churningScreen(++reads);
    const env = {
      registry: snapshotRegistry(shotPath, "churn-current-snapshot"),
      ctx: { artifacts: new ArtifactStore() },
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "churn",
      maxMismatch: 0.5,
      updateBaselines: true,
      cropOn: CROP_ON,
    });
    await vi.advanceTimersByTimeAsync(3_500);
    const result = await pending;

    // Verbatim: dropping the `converged` conjunct from the `skipped` arm maps
    // this to the undegraded `skipped` outcome, which strips the suffix
    // entirely and makes the bare reason indistinguishable from a healthy one.
    expect(result.status).toBe("pass");
    expect(result.reason).toBe(
      `baseline written (${cropKey("churn")}.png); ` +
        "capture is best-effort/degraded because visual settling timed out"
    );
    expect(result.snapshotKey).toBe(cropKey("churn"));
    // The tree phase never converged, so the pixel phase was never reached —
    // "skipped" here is the initial verdict, not a probed absence.
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    // 12 polls at the 250ms cadence fill the 3s tree window, then the settle
    // hands back best-effort while the action budget still has room.
    expect(reads).toBe(12);
    // Best-effort is still adopted under --update-baselines: the CROPPED region.
    const baseline = path.join(tmpDir, "__baselines__", "checkout", `${cropKey("churn")}.png`);
    const written = PNG.sync.read(await fs.readFile(baseline));
    expect({ w: written.width, h: written.height }).toEqual({ w: 50, h: 50 });
  });

  it("degrades a cropOn baseline whose paired settle went pixel-dark and then never re-converged", async () => {
    // Same pairing, the other unconverged verdict. Reads 1–2 match, so the
    // tree phase converges and the pixel phase runs; the capture backend
    // answers `undefined`, latching `visual: "unavailable"`. The post-pixel
    // revalidation read then shows the tree moved, restarting the settle — and
    // the restarted tree phase churns to its window, so the sticky
    // `unavailable` comes back with `converged: false`. A converged
    // `unavailable` is a probed-and-absent capture channel and says so; this
    // one additionally never settled the tree, so "timed out" is the honest
    // report.
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "dark-churn-snapshot.png");
    await writeCropCapture(shotPath);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Reads 1–2 are identical (the converging pair); from read 3 — the
      // post-pixel revalidation — on, the sibling ticks every read.
      return churningScreen(reads <= 2 ? 0 : reads);
    };
    vi.mocked(capturePixels).mockResolvedValue(undefined);
    const env = {
      registry: snapshotRegistry(shotPath, "dark-churn-current-snapshot"),
      ctx: { artifacts: new ArtifactStore() },
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "dark-churn",
      maxMismatch: 0.5,
      updateBaselines: true,
      cropOn: CROP_ON,
    });
    await vi.advanceTimersByTimeAsync(3_500);
    const result = await pending;

    // Verbatim: dropping the `converged` conjunct from the `unavailable` arm
    // swaps this for "…because visual settling was unavailable", reporting a
    // missing capture backend on a screen that simply never stopped moving.
    expect(result.status).toBe("pass");
    expect(result.reason).toBe(
      `baseline written (${cropKey("dark-churn")}.png); ` +
        "capture is best-effort/degraded because visual settling timed out"
    );
    expect(result.snapshotKey).toBe(cropKey("dark-churn"));
    // One dark capture is what latched `unavailable`, and the restarted tree
    // phase never converges, so no second capture is ever reached.
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(1);
    // The converging pair, the revalidation read that observed the move, then
    // 12 polls filling the restarted phase's 3s window.
    expect(reads).toBe(15);
    const baseline = path.join(tmpDir, "__baselines__", "checkout", `${cropKey("dark-churn")}.png`);
    const written = PNG.sync.read(await fs.readFile(baseline));
    expect({ w: written.width, h: written.height }).toEqual({ w: 50, h: 50 });
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
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await pending;

    expect(settled).toMatchObject({ tree: after, converged: false, treeFresh: true });
    // The hung warm capture is bounded independently, then the moved tree
    // restarts once and discovers the now-unavailable backend.
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

  it("invalidates pre-pixel tree freshness until post-pixel revalidation succeeds", async () => {
    vi.useFakeTimers();
    const stable = screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    const revalidationFailure = new Error("transient post-pixel tree failure");
    let reads = 0;
    currentTree = () => {
      reads++;
      return reads <= 2 ? stable : Promise.reject(revalidationFailure);
    };
    // Cross the ordinary combined phase after the tree has converged, then
    // soft-fail the pixel source. The mandatory final tree read still runs in
    // its reserved hard-deadline slice and rejects immediately.
    vi.mocked(capturePixels).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 5_000);
        })
    );
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = settleTree(env, { absoluteDeadline: Date.now() + 7_500 });
    await vi.advanceTimersByTimeAsync(5_500);
    const settled = await pending;

    // The returned tree is the stable pre-pixel sample. It cannot supply
    // selector coordinates after pixel work until a post-pixel read succeeds.
    expect(settled).toEqual({
      tree: stable,
      converged: false,
      treeFresh: false,
      visual: "unavailable",
    });
    expect(reads).toBe(3);
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

  it("best-efforts a selector gesture from the last settled tree when reads hang mid-action", async () => {
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
    const registry = mockRegistry(calls);
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "tap",
      selector: { text: "Go", loose: true },
    });
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(8_000);
    await resolved;

    // Reads going quiet mid-action are a settle timeout, which the taxonomy
    // explicitly refuses to read as an outage — an in-flight hierarchy read
    // may still succeed after we stop waiting. Holding the first round's
    // settled tree, the retry round's FlowTreeSettleTimeoutError resolves the
    // selector best-effort from that tree, exactly like the wait's own
    // deadline exhaustion; only a COMPLETED failing read (a proven source
    // outage) still errors the step.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.5 })
    );
  });

  it("bounds pixel polling by the ordinary phase window when an animator never settles", async () => {
    vi.useFakeTimers();
    // Perpetual tree-invisible motion (video, a shimmer, a colour pulse): the
    // tree fingerprint is identical on every read while no two captures ever
    // match.
    let white = false;
    vi.mocked(capturePixels).mockImplementation(async () => {
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let settledAt = -1;
    const pending = settleTree(env, { absoluteDeadline: Date.now() + 7_500 }).then((result) => {
      settledAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    // The polling loop exits around the 5s ordinary phase window — at most
    // one round past it, for a capture launched just inside — instead of
    // spinning captures to the 7.25s hard pixel ceiling. What remains of the
    // 7.5s action budget is exactly the retry room the phase window exists
    // for; the healthy instant final read keeps the tree fresh, so the
    // caller can act immediately rather than settling all over again.
    expect(settled).toMatchObject({ converged: false, treeFresh: true, visual: "timed-out" });
    expect(settledAt - startedAt).toBeGreaterThanOrEqual(5_000);
    expect(settledAt - startedAt).toBeLessThanOrEqual(5_500);
  });

  it("taps within the ordinary phase window when a perpetual animator never stops", async () => {
    vi.useFakeTimers();
    let white = false;
    vi.mocked(capturePixels).mockImplementation(async () => {
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const calls: string[] = [];
    let dispatchedAt = -1;
    const registry = mockRegistry(calls, undefined, (id) => {
      if (id === "gesture-tap") dispatchedAt = Date.now();
    });
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    const pending = runDirective(env, { kind: "tap", selector: { text: "Go", loose: true } });
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(7_500);
    await resolved;

    // One settle round exits its pixel phase at the ordinary window and its
    // final read keeps the tree fresh, so the element — on screen the whole
    // time — resolves at ~5s with ~2.5s of action budget unspent, not as a
    // last-gasp stale resolve at the 7.5s deadline. An element whose
    // lifetime outlives the phase window but not the hard pixel ceiling is
    // the difference between this step passing and failing.
    expect(dispatchedAt - startedAt).toBeGreaterThanOrEqual(5_000);
    expect(dispatchedAt - startedAt).toBeLessThanOrEqual(5_500);
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.5 })
    );
  });

  it("completes an ordinary-latency final read after a phase-bounded pixel timeout", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads <= 2) return visible;
      // The post-pixel revalidation read lands on a hierarchy that just grew
      // (an emulator mounting nodes mid-step): healthy, merely slow — far
      // over the 250ms reserve, well inside the remaining action budget.
      return new Promise((resolve) => {
        setTimeout(() => resolve(visible), 1_500);
      });
    };
    let white = false;
    vi.mocked(capturePixels).mockImplementation(async () => {
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const env = {
      registry: mockRegistry([]),
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;
    const startedAt = Date.now();

    let settledAt = -1;
    const pending = settleTree(env, { absoluteDeadline: Date.now() + 7_500 }).then((result) => {
      settledAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const settled = await pending;

    // The pixel loop exits at the phase window (~5s); the final read then
    // runs on the ordinary source read budget — the same budget tree-phase
    // reads get — instead of the 250ms reserve, so the 1.5s read completes
    // and the settle hands back a FRESH tree with retry budget standing. The
    // reserve slice remains only the floor for a capture that genuinely ran
    // to the hard ceiling. Cutting this read at the reserve would report a
    // healthy screen stale on every settle and force a doomed late retry.
    expect(settled).toMatchObject({ converged: false, treeFresh: true, visual: "timed-out" });
    expect(reads).toBe(3);
    expect(settledAt - startedAt).toBeGreaterThanOrEqual(6_500);
    expect(settledAt - startedAt).toBeLessThanOrEqual(7_000);
  });

  it("best-efforts a selector tap when a late retry settle times out with no read at all", async () => {
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads <= 2) return visible;
      // The phase-bounded settle's revalidation read blips…
      if (reads === 3) return Promise.reject(new Error("transient describe blip"));
      // …and by the retry round the deadline is nearly gone: the hierarchy
      // read outlives the remaining action budget entirely.
      return new Promise<DescribeNode>(() => {});
    };
    let white = false;
    vi.mocked(capturePixels).mockImplementation(async () => {
      white = !white;
      return solid(white ? [255, 255, 255] : [0, 0, 0]);
    });
    const calls: string[] = [];
    const registry = mockRegistry(calls);
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, { kind: "tap", selector: { text: "Go", loose: true } });
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(9_000);
    await resolved;

    // The retry settle's no-read window types as FlowTreeSettleTimeoutError.
    // Holding a settled tree from the first round, the wait treats it exactly
    // like its own deadline exhaustion — a terminal best-effort resolve from
    // the last valid tree — never a step error.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.5 })
    );
    // The phase-bounded first round left enough budget for the retry round to
    // exist at all: its read (the fourth) was actually launched.
    expect(reads).toBeGreaterThanOrEqual(4);
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
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;

      // The literal coordinates consult no selector: settled pixels are proof
      // enough, and the missing revalidation read must not fail the step.
      expect(result.ok).toBe(true);
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      // …and that proof is accepted the moment the first settle returns —
      // tree pair at 250ms, matching captures at 400ms, hung revalidation
      // read cut off at the 5s combined phase window — not by burning the
      // rest of the action budget until the terminal best-effort dispatch.
      expect(dispatchedAt - start).toBe(5_000);
      expect(dispatchedAt - start).toBeLessThan(DEFAULT_ACTION_TIMEOUT_MS);
      if (kind === "tap") {
        expect(registry.invokeTool).toHaveBeenCalledWith(
          "gesture-tap",
          expect.objectContaining({ x: 0.3, y: 0.7 })
        );
      }
    }
  );

  it.each(["tap", "long-press"] as const)(
    "accepts settled pixels for a raw-coordinate %s before the tree source starts failing",
    async (kind) => {
      vi.useFakeTimers();
      const visible = screen([
        n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]);
      let reads = 0;
      currentTree = () => {
        reads++;
        // Reads 1–2 converge the tree pair; the post-pixel revalidation read
        // (3) hangs; then the source stops hanging and starts FAILING — the
        // devtools connection dropped after the pixels already settled.
        if (reads <= 2) return visible;
        if (reads === 3) return new Promise<DescribeNode>(() => {});
        throw new Error("native devtools disconnected");
      };
      vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
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
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;

      // The first settle already proved the screen stopped ({treeFresh:
      // false, visual: "settled"}), and literal coordinates never consult
      // the tree, so that round must be accepted as-is. Re-settling instead
      // would hand the retry to the now-broken source, whose completed
      // failure escalates to FlowTreeSourceUnavailableError — erroring a
      // step that had its answer, with no gesture ever dispatched.
      expect(result.ok).toBe(true);
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      expect(dispatchedAt - start).toBe(5_000);
      // Dispatch rode the first settle: the failing reads were never taken.
      expect(reads).toBe(3);
      if (kind === "tap") {
        expect(registry.invokeTool).toHaveBeenCalledWith(
          "gesture-tap",
          expect.objectContaining({ x: 0.3, y: 0.7 })
        );
      }
    }
  );

  it.each(["tap", "long-press"] as const)(
    "dispatches a raw-coordinate %s at the deadline when the initial tree read hangs",
    async (kind) => {
      vi.useFakeTimers();
      currentTree = () => new Promise<DescribeNode>(() => {});
      const calls: string[] = [];
      let dispatchedAt = -1;
      const registry = mockRegistry(calls, undefined, (id) => {
        if (id.startsWith("gesture-")) dispatchedAt = Date.now();
      });
      const env = {
        registry,
        device: { platform: "ios", id: DEVICE },
      } as unknown as ActionEnv;
      const startedAt = Date.now();

      const pending = runDirective(
        env,
        kind === "tap" ? { kind, x: 0.3, y: 0.7 } : { kind, x: 0.3, y: 0.7, duration: 500 }
      );
      const resolved = expect(pending).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(7_500);
      await resolved;

      expect(dispatchedAt - startedAt).toBe(7_500);
      expect(calls).toContain(kind === "tap" ? "gesture-tap" : "gesture-custom");
      expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
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

  it("uses a 3.5s successful tree read in a later tree-only scroll round", async () => {
    vi.useFakeTimers();
    const before = screen([
      n({ label: "Before", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
    ]);
    const after = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.2 } }),
    ]);
    let scrolled = false;
    currentTree = () => {
      if (!scrolled) return before;
      return new Promise((resolve) => {
        setTimeout(() => resolve(after), 3_500);
      });
    };
    vi.mocked(capturePixels).mockResolvedValue(solid([255, 255, 255]));
    const calls: string[] = [];
    const registry = mockRegistry(calls, undefined, (id) => {
      if (id === "gesture-swipe") scrolled = true;
    });
    const env = {
      registry,
      device: { platform: "ios", id: DEVICE },
    } as unknown as ActionEnv;

    const pending = runDirective(env, {
      kind: "scroll-to",
      target: { text: "Target" },
      direction: "down",
    });
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(4_500);
    await resolved;

    expect(calls.filter((id) => id === "gesture-swipe")).toHaveLength(1);
    expect(vi.mocked(capturePixels)).toHaveBeenCalledTimes(2);
  });

  it("uses a 5.2s successful tree read for a scroll-to whose target is already visible", async () => {
    // scroll-to is the one directive whose settles carry no caller deadline, so
    // its reads run on the unowned fallback. A healthy read landing between the
    // old 5s combined-phase cap and the shared 7.5s action budget must be used,
    // not converted into a fabricated settle timeout only scroll-to would see.
    vi.useFakeTimers();
    const visible = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.2 } }),
    ]);
    currentTree = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(visible), 5_200);
      });
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
    const resolved = expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(6_000);
    await resolved;

    // The late read alone resolves the fully visible target: no scroll, and no
    // pixel phase after a tree phase that already outlived its polling window.
    expect(calls.filter((id) => id === "gesture-swipe")).toHaveLength(0);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
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

  it("dispatches no scroll from the stale first round's best-effort tree", async () => {
    vi.useFakeTimers();
    // Unlike the retry test above (target fully visible throughout, where the
    // axis check returns before any increment either way), the stale
    // best-effort tree here shows the target still flush against the fold —
    // falling through the stale round would fingerprint that tree and swipe at
    // its coordinates. The fresh tree served after the hung revalidation shows
    // the target already fully inside, so the correct run dispatches NOTHING:
    // any gesture at all can only have come from the stale round.
    const staleTree = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.85, width: 0.8, height: 0.15 } }),
    ]);
    const freshTree = screen([
      n({ label: "Target", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }),
    ]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Reads 1–2 converge round 0's tree phase on the stale layout; read 3 is
      // the post-pixel revalidation, hung so the combined settle comes back
      // treeFresh: false with the stale tree as best effort. Every later read
      // (round 1's tree-only settle) sees the fresh layout.
      if (reads <= 2) return staleTree;
      if (reads === 3) return new Promise<DescribeNode>(() => {});
      return freshTree;
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

    expect(result.ok).toBe(true);
    // Exactly zero device invocations: the stale round suppressed its
    // increment and the fresh round found the target in place.
    expect(calls).toEqual([]);
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

  it("degrades the baseline write when no hierarchy read ever completes", async () => {
    // The other half of settleSnapshot's FlowTreeSettleTimeoutError catch. The
    // test above pins the `staleSettled` arm — pixels proved still, only the
    // confirming read hung, so the write stays undegraded. Here NOTHING ever
    // established stillness: every hierarchy read hangs forever, the first
    // settle's sole read consumes the whole shared 7.5s action budget, and
    // settleTree throws FlowTreeSettleTimeoutError with `staleSettled` still
    // false. The catch must answer "timed-out": the baseline is still adopted
    // (the note is informational — status stays "pass"), but the reason must
    // carry the degradation suffix. Answering "settled" instead would hand an
    // --update-baselines run a bare "baseline written" for a screen no read
    // or capture ever proved still — indistinguishable from a healthy one.
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "hung-tree-snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    currentTree = () => new Promise<DescribeNode>(() => {});
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "hung-tree-current-snapshot",
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
    const startedAt = Date.now();

    let settledAt = -1;
    const pending = runSnapshot(env, {
      flowsDir: tmpDir,
      flowName: "checkout",
      name: "hung-tree",
      maxMismatch: 0.5,
      updateBaselines: true,
    }).then((result) => {
      settledAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const result = await pending;

    expect(result.status).toBe("pass");
    expect(result.reason).toBe(
      "baseline written (hung-tree__ios-390x844.png); " +
        "capture is best-effort/degraded because visual settling timed out"
    );
    // The hung read was bounded at exactly DEFAULT_ACTION_TIMEOUT_MS — the
    // caller-owned deadline settleSnapshot hands settleTree — and the tree
    // phase threw before the pixel phase could start, so no capture ran:
    // "timed-out" is the honest verdict, not a stillness anyone observed.
    expect(settledAt - startedAt).toBe(DEFAULT_ACTION_TIMEOUT_MS);
    expect(vi.mocked(capturePixels)).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(tmpDir, "__baselines__", "checkout", "hung-tree__ios-390x844.png"))
    ).resolves.toBeUndefined();
  });

  it("degrades the baseline write when the stale-settled round's freshness retry burns its pixel budget", async () => {
    // The integration join the settle taxonomy leans on: the REAL settleTree's
    // pixel-loop timeout verdict (here its sleep-clamp arm — the poll sleep
    // clamps to zero remaining pixel budget) must reach the REAL
    // settleSnapshot's `visual === "timed-out"` branch, which overrides the
    // earlier stale-but-settled round and lands the degradation note on the
    // baseline write. Relabelling that arm's verdict would silently turn this
    // into an undegraded bare "baseline written".
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "pulse-snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    const stable = screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Round 1: reads 1–2 converge the tree phase; the post-pixel
      // revalidation read (3) hangs past its window, so the settle comes back
      // stale-but-settled ({ visual: "settled", treeFresh: false }). Every
      // read after that — the freshness retry's converging pair and its
      // revalidation — succeeds instantly.
      return reads === 3 ? new Promise<DescribeNode>(() => {}) : stable;
    };
    const startedAt = Date.now();
    let captures = 0;
    vi.mocked(capturePixels).mockImplementation(() => {
      captures++;
      // Round 1: a matching pair — the screen looked still while the
      // revalidation read hung.
      if (captures <= 2) return Promise.resolve(solid([255, 255, 255]));
      // Freshness retry: a perpetual animator. No capture ever matches
      // another again, and the retry's first capture only delivers its frame
      // at the exact instant the pixel budget (hardDeadline minus the
      // final-read reserve, t0+7250) runs out — the next poll's sleep clamps
      // to zero and the loop exits through the sleep-clamp timed-out arm
      // before any warm capture runs.
      const delay = Math.max(0, startedAt + 7_250 - Date.now());
      return new Promise((resolve) => {
        setTimeout(() => resolve(solid(captures % 2 === 1 ? [0, 0, 0] : [64, 64, 64])), delay);
      });
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "pulse-current-snapshot",
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
      name: "pulse",
      maxMismatch: 0.5,
      updateBaselines: true,
    });
    await vi.advanceTimersByTimeAsync(7_500);
    const result = await pending;

    // The retry's pixel phase launched a capture and never proved stillness
    // strictly after the stale pair matched, so its honest timeout wins over
    // the round-1 stale claim: the baseline still gets written, but the
    // reason must carry the degradation note verbatim.
    expect(result.status).toBe("pass");
    expect(result.reason).toBe(
      "baseline written (pulse__ios-390x844.png); " +
        "capture is best-effort/degraded because visual settling timed out"
    );
    // Pins the driven path: round 1's matching pair plus exactly the one
    // budget-consuming retry capture — the timed-out verdict came from the
    // sleep-clamp arm, before any warm capture could run.
    expect(captures).toBe(3);
    // Two converging reads + hung revalidation, then the retry's converging
    // pair + its successful revalidation — one retry round, nothing more.
    expect(reads).toBe(6);
    await expect(
      fs.access(path.join(tmpDir, "__baselines__", "checkout", "pulse__ios-390x844.png"))
    ).resolves.toBeUndefined();
  });

  it("keeps the baseline write undegraded when the stale-settled round's freshness retries go pixel-dark", async () => {
    // The other half of the latch the test above pins. There the freshness
    // retry's pixel phase RAN and never re-proved stillness, so its honest
    // timeout overrides the stale round-1 claim. Here the retries are
    // pixel-DARK — the capture backend vanishes (`capturePixels` resolves
    // undefined) while the tree stays healthy, so each retry comes back
    // `{ visual: "unavailable", converged: true }`. A dark reading cannot
    // un-prove the stillness round 1 already established, so settleSnapshot's
    // `!staleSettled` guard must skip the direct `unavailable` mapping and
    // keep chasing freshness to the action deadline: the baseline write stays
    // a bare "baseline written", no degradation note. Dropping the guard
    // would let the FIRST dark retry stamp "visual settling was unavailable"
    // onto a screen whose quiet was already proven.
    vi.useFakeTimers();
    const shotPath = path.join(tmpDir, "calm-snapshot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(shotPath, png);
    const stable = screen([n({ label: "Go", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    let reads = 0;
    currentTree = () => {
      reads++;
      // Round 1: reads 1–2 converge the tree phase; the post-pixel
      // revalidation read (3) hangs past the phase window, so the settle
      // comes back stale-but-settled ({ visual: "settled", treeFresh: false }).
      // Every read after that succeeds instantly, so each freshness retry's
      // tree phase converges and its revalidation read is fresh — the retry
      // shortfall is purely the dark pixel phase, never the tree.
      return reads === 3 ? new Promise<DescribeNode>(() => {}) : stable;
    };
    let captures = 0;
    vi.mocked(capturePixels).mockImplementation(() => {
      captures++;
      // Round 1: a matching pair — the screen provably still while the
      // revalidation read hung. From the retry on, the backend is gone:
      // `undefined` types each retry's pixel phase as the pixel-dark
      // `unavailable`, never `timed-out`, so only the unpinned guard — not
      // the timed-out override arm above — decides the outcome.
      return Promise.resolve(captures <= 2 ? solid([255, 255, 255]) : undefined);
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "screenshot") {
          return {
            image: {
              __argentArtifact: true,
              id: "calm-current-snapshot",
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
      name: "calm",
      maxMismatch: 0.5,
      updateBaselines: true,
    });
    await vi.advanceTimersByTimeAsync(7_600);
    const result = await pending;

    // The reason must be the bare write — asserted verbatim so no degradation
    // suffix (or any other annotation) can sneak in unnoticed.
    expect(result.status).toBe("pass");
    expect(result.reason).toBe("baseline written (calm__ios-390x844.png)");
    // Pins the latch actually holding across retries, not just the final
    // verdict: round 1 spends reads 1–2, hung read 3 and captures 1–2, ending
    // at the 5s phase window; then FOUR pixel-dark retry rounds (two
    // converging reads + one dark capture + one fresh revalidation read each,
    // separated by the 300ms retry sleep) at 5.3s, 5.85s, 6.4s and 6.95s,
    // with the deadline landing on the sleep after the fourth. A guard that
    // let the first dark retry through would stop at 6 reads / 3 captures —
    // and degrade the reason.
    expect(captures).toBe(6);
    expect(reads).toBe(15);
    await expect(
      fs.access(path.join(tmpDir, "__baselines__", "checkout", "calm__ios-390x844.png"))
    ).resolves.toBeUndefined();
  });
});

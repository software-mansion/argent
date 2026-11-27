import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { gestureHoverTool } from "../src/tools/gesture-hover";
import { gestureScrollTool } from "../src/tools/gesture-scroll";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import {
  MACOS_POINTER_TAKEN_OVER_HINT,
  projectMacosDescribeTree,
  readMacosTree,
} from "../src/tools/describe/platforms/macos";
import { MACOS_HOVER_SETTLE_MS } from "../src/utils/macos-input";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import { fakeMacosLibrary, probeTree } from "./helpers/macos-tree-fixture";
import {
  MAC_BUNDLE_ID,
  MAC_ID,
  MAC_PID,
  errorOf,
  fakeMacosApp,
  macosToolRegistry,
} from "./helpers/macos-input-fake";

useMacosAppsFlag();

afterEach(() => {
  vi.useRealTimers();
});

/** A library with hover support: it says so in the reply to every move. */
const hovering = {
  "Input.mouse": (p: Record<string, unknown>) =>
    p.type === "move" || p.type === "leave" ? { hover: true } : {},
};

function harness(handlers: Parameters<typeof fakeMacosApp>[0] = hovering) {
  const fake = fakeMacosApp(handlers);
  const { registry, urns } = macosToolRegistry(fake.app, (registry) => [
    gestureHoverTool,
    gestureTapTool,
    gestureScrollTool,
    createRunSequenceTool(registry),
  ]);
  const invoke = (id: string, args: Record<string, unknown>, udid = MAC_ID, signal?: AbortSignal) =>
    registry.invokeTool(id, { udid, ...args }, signal ? { signal } : undefined);
  return { ...fake, invoke, urns };
}

const moves = (calls: ReturnType<typeof harness>["calls"]) =>
  calls.filter((c) => c.params.type === "move").map((c) => ({ x: c.params.x, y: c.params.y }));

describe("gesture-hover on a Mac app", () => {
  it("glides from argent's last pointer point, ends exactly on the target, then settles", async () => {
    vi.useFakeTimers();
    const { invoke, calls } = harness();
    const tap = invoke("gesture-tap", { x: 0.1, y: 0.2 });
    await vi.runAllTimersAsync();
    await tap;
    calls.length = 0;

    let done = false;
    const hover = invoke("gesture-hover", { x: 0.7, y: 0.9, durationMs: 160 }).then((r) => {
      done = true;
      return r;
    });
    // 10 moves 16 ms apart, then the settle wait.
    await vi.advanceTimersByTimeAsync(9 * 16 + MACOS_HOVER_SETTLE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(hover).resolves.toMatchObject({ hovered: true });

    const path = moves(calls);
    expect(calls).toHaveLength(10);
    expect(path.at(-1)).toEqual({ x: 0.7, y: 0.9 });
    expect(path[0].x).toBeCloseTo(0.16);
    expect(path[0].y).toBeCloseTo(0.27);
    for (let i = 1; i < path.length; i++) {
      expect(path[i].x as number).toBeGreaterThan(path[i - 1].x as number);
      expect(path[i].y as number).toBeGreaterThan(path[i - 1].y as number);
    }
  });

  it("stops moving when the call is cancelled mid-glide", async () => {
    vi.useFakeTimers();
    const { invoke, calls } = harness();
    const tap = invoke("gesture-tap", { x: 0.1, y: 0.2 });
    await vi.runAllTimersAsync();
    await tap;
    calls.length = 0;

    const controller = new AbortController();
    const hover = errorOf(
      invoke("gesture-hover", { x: 0.7, y: 0.9, durationMs: 160 }, MAC_ID, controller.signal)
    );
    await vi.advanceTimersByTimeAsync(2 * 16);
    controller.abort();
    await vi.runAllTimersAsync();
    const err = await hover;
    expect(err?.message).toMatch(/gesture-hover aborted - cancelled after/);
    expect(moves(calls).length).toBeLessThan(10);
    expect(moves(calls).at(-1)).not.toEqual({ x: 0.7, y: 0.9 });
  });

  it("glides from where a scroll left argent's pointer", async () => {
    const { invoke, calls } = harness({
      ...hovering,
      "Input.scroll": () => ({ method: "scrollWheel" }),
    });
    await invoke("gesture-scroll", { x: 0.8, y: 0.8, deltaY: 0.1 });
    calls.length = 0;
    await invoke("gesture-hover", { x: 0.2, y: 0.2, durationMs: 32 });
    const path = moves(calls);
    expect(path).toHaveLength(2);
    expect(path[0].x).toBeCloseTo(0.5);
    expect(path[0].y).toBeCloseTo(0.5);
  });

  it("moves straight to the target when argent has not moved the pointer in this process", async () => {
    const { invoke, calls, app } = harness();
    await invoke("gesture-hover", { x: 0.4, y: 0.5 });
    expect(moves(calls)).toEqual([{ x: 0.4, y: 0.5 }]);

    // The app was relaunched: the point argent left belongs to the old process.
    vi.mocked(app.handshake).mockReturnValue({
      bundleId: MAC_BUNDLE_ID,
      pid: MAC_PID + 1,
      platform: "macos",
      protocol: 1,
    });
    calls.length = 0;
    await invoke("gesture-hover", { x: 0.6, y: 0.5 });
    expect(moves(calls)).toEqual([{ x: 0.6, y: 0.5 }]);
  });

  it("refuses with MACOS_APP_LIBRARY_OUTDATED after one move when the library does not hover", async () => {
    // An older library answers a move without `hover`.
    const { invoke, calls } = harness({});
    const tap = await invoke("gesture-tap", { x: 0.1, y: 0.1 });
    expect(tap).toMatchObject({ tapped: true });
    calls.length = 0;

    const err = await errorOf(invoke("gesture-hover", { x: 0.9, y: 0.9 }));
    expect(err?.message).toContain("cannot hover");
    expect(err?.message).toContain("restart-app");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED);
    expect(calls).toHaveLength(1);
  });

  it("ends the hover with a leave, after which the next hover goes straight to its point", async () => {
    const { invoke, calls } = harness();
    await invoke("gesture-hover", { x: 0.2, y: 0.2 });
    await expect(invoke("gesture-hover", { leave: true })).resolves.toMatchObject({ left: true });
    expect(calls.at(-1)?.params).toEqual({ type: "leave" });

    calls.length = 0;
    await invoke("gesture-hover", { x: 0.8, y: 0.8 });
    expect(moves(calls)).toEqual([{ x: 0.8, y: 0.8 }]);
  });

  it("maps an older library's refusal of leave to MACOS_APP_LIBRARY_OUTDATED", async () => {
    const { invoke } = harness({
      "Input.mouse": (p) => {
        if (p.type === "leave") throw new Error("type must be down, up or move");
        return { hover: true };
      },
    });
    const err = await errorOf(invoke("gesture-hover", { leave: true }));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED);
    expect(err?.message).toContain("restart-app");
  });

  it.each([[{ x: 0.5 }], [{ leave: true, x: 0.5, y: 0.5 }], [{ leave: true, durationMs: 100 }]])(
    "refuses %j before sending anything",
    async (args) => {
      const { invoke, calls } = harness();
      const err = await errorOf(invoke("gesture-hover", args));
      expect(err?.message).toContain("leave: true alone");
      expect(calls).toHaveLength(0);
    }
  );

  it("refuses a device that is not a Mac app, also as a run-sequence step", async () => {
    const { invoke, calls, urns } = harness();
    const ios = "00000000-0000-0000-0000-0000000000AB";
    const err = await errorOf(invoke("gesture-hover", { x: 0.5, y: 0.5 }, ios));
    expect(err?.message).toMatch(/Tool 'gesture-hover' is not supported on ios simulator/);
    const seq = (await invoke(
      "run-sequence",
      { steps: [{ tool: "gesture-hover", args: { x: 0.5, y: 0.5 } }] },
      "chromium-cdp-9222"
    )) as { completed: number; steps: Array<{ error?: string }> };
    expect(seq.completed).toBe(0);
    expect(seq.steps[0].error).toMatch(/not supported on chromium/);
    expect(calls).toHaveLength(0);
    expect(urns).toEqual([]);
  });

  it("runs as a run-sequence step on a Mac app", async () => {
    const { invoke, calls } = harness();
    const seq = await invoke("run-sequence", {
      steps: [
        { tool: "gesture-hover", args: { x: 0.3, y: 0.3 }, delayMs: 0 },
        { tool: "gesture-hover", args: { leave: true }, delayMs: 0 },
      ],
    });
    expect(seq).toMatchObject({ completed: 2, total: 2 });
    expect(calls.map((c) => c.params.type)).toEqual(["move", "leave"]);
  });
});

describe("describe on a Mac app after the user took the pointer back", () => {
  it.each([true, false])("says so only when pointerTakenOver is %s", async (pointerTakenOver) => {
    const lib = fakeMacosLibrary({ trees: [{ ...probeTree(), pointerTakenOver }] });
    const data = projectMacosDescribeTree(await readMacosTree(lib.api));
    expect(data.hint?.includes(MACOS_POINTER_TAKEN_OVER_HINT) ?? false).toBe(pointerTakenOver);
  });
});

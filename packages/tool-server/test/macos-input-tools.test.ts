import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Mac branch needs no host binary; the iOS branches of the native tools probe
// xcrun. Recorded so a test can prove the Mac path skips it.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));

import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { ensureDeps } from "../src/utils/check-deps";
import { MACOS_CLICK_SETTLE_MS } from "../src/utils/macos-input";
import { RESULT_NOTE_KEY } from "../src/tools/screenshot/dropped-geometry";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { gestureScrollTool } from "../src/tools/gesture-scroll";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createPasteTool } from "../src/tools/paste";
import { createScreenshotTool } from "../src/tools/screenshot";
import { createScreenshotDiffTool } from "../src/tools/screenshot-diff";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { createDescribeTool } from "../src/tools/describe";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { openUrlTool } from "../src/tools/open-url";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../src/tools/native-devtools/native-full-hierarchy";
import { nativeViewAtPointTool } from "../src/tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../src/tools/native-devtools/native-user-interactable-view-at-point";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MAC_BUNDLE_ID,
  MAC_ID,
  MAC_URN,
  errorOf,
  fakeMacosApp,
  macosToolRegistry,
} from "./helpers/macos-input-fake";

const flag = useMacosAppsFlag();

function pngBytes(width: number, height: number, paint?: (x: number, y: number) => boolean) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const red = paint?.(x, y) ?? false;
      png.data.set([255, red ? 0 : 255, red ? 0 : 255, 255], i);
    }
  }
  return PNG.sync.write(png);
}

/** The tools under test on a registry whose only service is the fake library. */
function harness(handlers: Parameters<typeof fakeMacosApp>[0] = {}) {
  const { app, calls } = fakeMacosApp(handlers);
  const { registry, urns } = macosToolRegistry(app, (registry) => [
    gestureTapTool,
    gestureDragTool,
    gestureScrollTool,
    gestureSwipeTool,
    createKeyboardTool(registry),
    createPasteTool(registry),
    createScreenshotTool(registry),
    createScreenshotDiffTool(registry),
    createRunSequenceTool(registry),
    createDescribeTool(registry),
    createAwaitUiElementTool(registry),
    createAwaitScreenIdleTool(registry),
    createLaunchAppTool(registry),
    createRestartAppTool(registry),
    openUrlTool,
    nativeDescribeScreenTool,
    nativeFindViewsTool,
    nativeFullHierarchyTool,
    nativeViewAtPointTool,
    nativeUserInteractableViewAtPointTool,
    nativeNetworkLogsTool,
  ]);
  const invoke = (id: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    registry.invokeTool(id, { udid: MAC_ID, ...args }, signal ? { signal } : undefined);
  return { registry, invoke, calls, urns };
}

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "argent-macos-input-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(ensureDeps).mockClear();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("gesture-tap on a Mac app", () => {
  it("clicks through the library and returns after the settle wait", async () => {
    vi.useFakeTimers();
    const { invoke, calls, urns } = harness();
    let done = false;
    const tap = invoke("gesture-tap", { x: 0.3, y: 0.4, clickCount: 2 }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(MACOS_CLICK_SETTLE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(tap).resolves.toMatchObject({ tapped: true });
    expect(calls.map((c) => [c.params.type, c.params.clickCount])).toEqual([
      ["move", undefined],
      ["down", 1],
      ["up", 1],
      ["down", 2],
      ["up", 2],
    ]);
    expect(urns).toEqual([MAC_URN]);
  });

  it("right-clicks through the library: each press and release names the right button", async () => {
    const { invoke, calls, urns } = harness();
    await expect(
      invoke("gesture-tap", { x: 0.3, y: 0.4, clickCount: 2, button: "right" })
    ).resolves.toMatchObject({ tapped: true });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["Input.mouse", { type: "move", x: 0.3, y: 0.4 }],
      ...[1, 2].flatMap((clickCount) =>
        (["down", "up"] as const).map((type) => [
          "Input.mouse",
          { type, x: 0.3, y: 0.4, button: "right", clickCount },
        ])
      ),
    ]);
    expect(urns).toEqual([MAC_URN]);
  });

  it("sends no button for a default click, so the library keeps its left default", async () => {
    const { invoke, calls } = harness();
    await invoke("gesture-tap", { x: 0.3, y: 0.4 });
    expect(calls.map((c) => c.params)).toEqual([
      { type: "move", x: 0.3, y: 0.4 },
      { type: "down", x: 0.3, y: 0.4, clickCount: 1 },
      { type: "up", x: 0.3, y: 0.4, clickCount: 1 },
    ]);
    expect(calls.every((c) => !("button" in c.params) || c.params.button === undefined)).toBe(true);
  });
});

describe("gesture-drag on a Mac app", () => {
  const drag = { fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 };

  it("presses at the start, moves with the button held to the end, releases there, then waits", async () => {
    vi.useFakeTimers();
    const { invoke, calls, urns } = harness();
    let done = false;
    const run = invoke("gesture-drag", { ...drag, durationMs: 64 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(64);
    // durationMs 64 -> 4 steps -> 4 moves between the press and the release, the last at the end.
    expect(calls.map((c) => c.params.type)).toEqual(["down", "move", "move", "move", "move", "up"]);
    expect(calls[0]!.params).toMatchObject({ x: 0.1, y: 0.5, clickCount: 1 });
    expect(calls.at(-1)!.params).toMatchObject({ x: 0.9, y: 0.5, clickCount: 1 });
    const xs = calls.slice(1, -1).map((c) => c.params.x as number);
    [0.3, 0.5, 0.7, 0.9].forEach((x, i) => expect(xs[i]).toBeCloseTo(x));
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(MACOS_CLICK_SETTLE_MS);
    await run;
    expect(urns).toEqual([MAC_URN]);
  });

  it("holds a same-point drag 800 ms by default, a long press", async () => {
    vi.useFakeTimers();
    const { invoke, calls } = harness();
    const run = invoke("gesture-drag", { fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 });
    await vi.advanceTimersByTimeAsync(790);
    expect(calls.map((c) => c.params.type)).not.toContain("up");
    await vi.advanceTimersByTimeAsync(10 + MACOS_CLICK_SETTLE_MS);
    await run;
    expect(calls.at(-1)!.params).toMatchObject({ type: "up", x: 0.5, y: 0.5 });
  });

  it("eases out for momentum: false, with at least eight samples", async () => {
    vi.useFakeTimers();
    const { invoke, calls } = harness();
    const run = invoke("gesture-drag", { ...drag, durationMs: 32, momentum: false });
    await vi.advanceTimersByTimeAsync(32 + MACOS_CLICK_SETTLE_MS);
    await run;
    const moves = calls.filter((c) => c.params.type === "move").map((c) => c.params.x as number);
    expect(moves).toHaveLength(8);
    // Each step covers less distance than the one before it.
    const deltas = moves.map((x, i) => x - (i === 0 ? 0.1 : moves[i - 1]!));
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!).toBeLessThan(deltas[i - 1]!);
  });

  it("releases where the pointer is when cancelled mid-drag", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { invoke, calls } = harness({
      "Input.mouse": (p) => {
        if (p.type === "move") controller.abort();
        return {};
      },
    });
    const settled = errorOf(
      invoke("gesture-drag", { ...drag, fromX: 0, toX: 1, durationMs: 160 }, controller.signal)
    );
    await vi.advanceTimersByTimeAsync(200);
    expect((await settled)?.message).toMatch(/gesture-drag aborted - cancelled mid-drag/);
    const last = calls.at(-1)!.params;
    expect(last.type).toBe("up");
    // The release is at the first (and only) move, not at the end point.
    expect(last.x).toBeCloseTo(0.1);
  });

  it("releases at the last position when a move fails", async () => {
    vi.useFakeTimers();
    let moves = 0;
    const { invoke, calls } = harness({
      "Input.mouse": (p) => {
        if (p.type === "move" && ++moves === 2) throw new Error("No app window at the point");
        return {};
      },
    });
    const settled = errorOf(invoke("gesture-drag", { ...drag, fromX: 0, toX: 1, durationMs: 160 }));
    await vi.advanceTimersByTimeAsync(200);
    expect((await settled)?.message).toMatch(/No app window at the point/);
    expect(calls.at(-1)!.params).toMatchObject({ type: "up", x: 0.1 });
  });

  it("moves every point on the top edge just inside the window, as a click and a scroll do", async () => {
    vi.useFakeTimers();
    const { invoke, calls } = harness();
    const run = invoke("gesture-drag", { fromX: 0.5, fromY: 0, toX: 1, toY: 0, durationMs: 48 });
    await vi.advanceTimersByTimeAsync(48 + MACOS_CLICK_SETTLE_MS);
    await run;
    for (const c of calls) expect(c.params.y).toBe(1e-4);
    expect(calls.at(-1)!.params).toMatchObject({ type: "up", x: 1 - 1e-4 });
    calls.length = 0;
    await invoke("gesture-scroll", { x: 1, y: 0, deltaY: 0.1 });
    expect(calls[0]!.params).toEqual({ x: 1 - 1e-4, y: 1e-4, deltaY: 0.1 });
  });
});

describe("gesture-scroll on a Mac app", () => {
  it("passes the window-fraction deltas through in one request", async () => {
    const { invoke, calls } = harness();
    await expect(invoke("gesture-scroll", { x: 0.5, y: 0.6, deltaY: 0.5 })).resolves.toMatchObject({
      scrolled: true,
    });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["Input.scroll", { x: 0.5, y: 0.6, deltaY: 0.5 }],
    ]);
  });
});

describe("the flag gate on flow sub-invocations", () => {
  it.each([
    ["gesture-tap", { x: 0.5, y: 0.5 }],
    ["gesture-drag", { fromX: 0.1, fromY: 0.1, toX: 0.2, toY: 0.2 }],
    ["gesture-scroll", { x: 0.5, y: 0.5, deltaY: 0.2 }],
    ["keyboard", { text: "hi" }],
    ["paste", { text: "hi" }],
    ["screenshot", {}],
    [
      "screenshot-diff",
      { baselinePath: "/no/baseline.png", captureCurrent: true, outputDir: os.tmpdir() },
    ],
    ["describe", {}],
    ["await-ui-element", { condition: "exists", selector: { text: "x" } }],
    ["await-screen-idle", {}],
    ["native-describe-screen", { bundleId: MAC_BUNDLE_ID }],
    ["native-find-views", { bundleId: MAC_BUNDLE_ID, identifier: "x" }],
    ["native-full-hierarchy", { bundleId: MAC_BUNDLE_ID }],
    ["native-view-at-point", { bundleId: MAC_BUNDLE_ID, x: 1, y: 1 }],
    ["native-user-interactable-view-at-point", { bundleId: MAC_BUNDLE_ID, x: 1, y: 1 }],
    ["native-network-logs", { bundleId: MAC_BUNDLE_ID }],
    // These three declare the library as a service whatever the flag says.
    ["launch-app", { bundleId: MAC_BUNDLE_ID }],
    ["restart-app", { bundleId: MAC_BUNDLE_ID }],
    ["open-url", { url: "probe://x" }],
  ])(
    "%s refuses with the flag message and sends the library nothing while the flag is off",
    async (id, args) => {
      flag.off();
      const { invoke, calls, urns } = harness();
      // Registry.invokeTool, the path flows take, skips the HTTP capability gate.
      const err = await errorOf(invoke(id, args));
      expect(err?.message).toMatch(/macos-apps flag is off\. Run: argent enable macos-apps/);
      expect(calls).toEqual([]);
      if (!["launch-app", "restart-app", "open-url"].includes(id)) expect(urns).toEqual([]);
    }
  );
});

describe("keyboard and paste on a Mac app", () => {
  it("keyboard types the split text and presses a shortcut", async () => {
    const { invoke, calls, urns } = harness();
    await expect(invoke("keyboard", { text: "aé", delayMs: 0 })).resolves.toEqual({
      typed: "aé",
      keys: 2,
    });
    await expect(invoke("keyboard", { key: "command+a" })).resolves.toEqual({
      typed: "command+a",
      keys: 1,
    });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["Input.key", { text: "a" }],
      ["Input.insertText", { text: "é" }],
      ["Input.key", { text: "a", modifiers: ["command"] }],
    ]);
    expect(urns.every((u) => u === MAC_URN)).toBe(true);
  });

  it("keyboard rejects an unknown key name before anything is sent", async () => {
    const { invoke, calls } = harness();
    const err = await errorOf(invoke("keyboard", { key: "hyper" }));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
    expect(calls).toEqual([]);
  });

  it("paste inserts the text at the focused element, never through a pasteboard", async () => {
    const { invoke, calls, urns } = harness();
    await expect(invoke("paste", { text: "line 1\nline 2" })).resolves.toEqual({ pasted: true });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["Input.insertText", { text: "line 1\nline 2" }],
    ]);
    expect(urns).toEqual([MAC_URN]);
  });

  it("paste into an element that takes no text says to click the field first", async () => {
    const { invoke } = harness({
      "Input.insertText": () => {
        throw new Error("First responder does not accept text");
      },
    });
    const err = await errorOf(invoke("paste", { text: "x" }));
    expect(err?.message).toMatch(/Click the text field first/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_INPUT_NOT_FOCUSED);
  });
});

describe("screenshot and screenshot-diff on a Mac app", () => {
  it("screenshot writes the library's PNG and returns it as an image artifact", async () => {
    const png = pngBytes(40, 30);
    const { invoke, calls, urns } = harness({
      "Screenshot.capture": () => ({ base64: png.toString("base64") }),
    });
    const result = (await invoke("screenshot", {})) as {
      image: { filename: string; mimeType: string };
    };
    expect(result.image.mimeType).toBe("image/png");
    const written = path.join(os.tmpdir(), result.image.filename);
    expect(fs.readFileSync(written)).toEqual(png);
    fs.rmSync(written);
    expect(calls.map((c) => c.params)).toEqual([{ scale: 1 }]);
    expect(urns).toEqual([MAC_URN]);
    expect(result).not.toHaveProperty(RESULT_NOTE_KEY);
  });

  it.each([
    [
      "no scale: a larger window is downscaled to a 768 px long side",
      {},
      undefined,
      [1000, 250],
      [768, 192],
      1,
    ],
    [
      "no scale: a window over 1280 points keeps 0.6 px per point",
      {},
      undefined,
      [1600, 400],
      [960, 240],
      1,
    ],
    ["ARGENT_SCREENSHOT_SCALE: ignored", {}, "0.25", [1600, 400], [960, 240], 1],
    [
      "an explicit scale: the library scales",
      { scale: 0.8 },
      undefined,
      [1600, 400],
      [1600, 400],
      0.8,
    ],
  ] as const)("screenshot with %s", async (_label, args, envScale, capture, size, libraryScale) => {
    if (envScale) vi.stubEnv("ARGENT_SCREENSHOT_SCALE", envScale);
    const { invoke, calls } = harness({
      "Screenshot.capture": () => ({ base64: pngBytes(capture[0], capture[1]).toString("base64") }),
    });
    const result = (await invoke("screenshot", args)) as { image: { filename: string } };
    const written = path.join(os.tmpdir(), result.image.filename);
    const png = PNG.sync.read(fs.readFileSync(written));
    fs.rmSync(written);
    vi.unstubAllEnvs();
    expect([png.width, png.height]).toEqual(size);
    expect(calls.map((c) => c.params)).toEqual([{ scale: libraryScale }]);
  });

  it("screenshot passes the scale and notes a rotation it cannot apply", async () => {
    const png = pngBytes(4, 4);
    const { invoke, calls } = harness({
      "Screenshot.capture": () => ({ base64: png.toString("base64") }),
    });
    const result = (await invoke("screenshot", { scale: 0.5, rotation: "LandscapeLeft" })) as {
      image: { filename: string };
    } & Record<string, unknown>;
    fs.rmSync(path.join(os.tmpdir(), result.image.filename));
    expect(calls[0]!.params).toEqual({ scale: 0.5 });
    expect(result[RESULT_NOTE_KEY]).toMatch(/Mac app screenshots cannot be rotated/);
  });

  it("screenshot-diff captures live through the library and does not mask the title bar", async () => {
    // A change in the top 3% of the window: under a phone's status-bar mask it
    // would be ignored, but on a Mac it is the title bar or toolbar.
    const baselinePath = path.join(sandbox, "baseline.png");
    fs.writeFileSync(baselinePath, pngBytes(200, 100));
    const current = pngBytes(200, 100, (x, y) => y < 3 && x < 100);
    const { invoke, calls, urns } = harness({
      "Screenshot.capture": () => ({ base64: current.toString("base64") }),
    });
    const result = (await invoke("screenshot-diff", {
      baselinePath,
      captureCurrent: true,
      outputDir: sandbox,
    })) as { summary: string; diffPath?: unknown };
    expect(calls.map((c) => c.params)).toEqual([{ scale: 1 }]);
    expect(urns).toEqual([MAC_URN]);
    // With a phone's status-bar mask the same pair reads "status: unchanged".
    expect(result.summary).toMatch(/- status: changed/);
    expect(result.diffPath).toBeDefined();
  });
});

describe("run-sequence on a Mac app", () => {
  it("runs the mouse and keyboard steps and stops at a touch-only step's gate", async () => {
    const { invoke, calls, urns } = harness();
    const result = (await invoke("run-sequence", {
      steps: [
        { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
        { tool: "keyboard", args: { text: "ok", delayMs: 0 }, delayMs: 0 },
        { tool: "gesture-swipe", args: { fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.3 } },
        { tool: "keyboard", args: { key: "enter" } },
      ],
    })) as { completed: number; steps: { tool: string; error?: string }[] };
    expect(result.completed).toBe(2);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2]!.error).toMatch(
      /not supported on macos app \(a Mac app takes mouse input: use gesture-drag/
    );
    expect(calls.map((c) => c.method)).toEqual([
      ...Array<string>(3).fill("Input.mouse"),
      ...Array<string>(2).fill("Input.key"),
    ]);
    expect(urns.every((u) => u === MAC_URN)).toBe(true);
  });
});

describe("native-* view tools on a Mac app", () => {
  const element = {
    frame: { x: 10, y: 40, width: 80, height: 20 },
    tapPoint: { x: 50, y: 50 },
    normalizedFrame: { x: 0.0111, y: 0.0633, width: 0.0889, height: 0.0316 },
    normalizedTapPoint: { x: 0.0556, y: 0.0791 },
    traits: ["button"],
    label: "Increment",
    identifier: "fixture.button",
  };

  it.each([
    [
      "native-describe-screen",
      { skipClasses: ["NSImageView"] },
      "ViewHierarchy.describeScreen",
      { screenFrame: { x: 0, y: 0, width: 900, height: 632 }, elements: [element] },
    ],
    [
      "native-find-views",
      { identifier: "fixture.button" },
      "ViewHierarchy.findViews",
      { matches: [{ className: "NSButton" }] },
    ],
    [
      "native-full-hierarchy",
      { maxDepth: 3 },
      "ViewHierarchy.getFullHierarchy",
      { windows: [{ className: "NSWindow" }] },
    ],
    [
      "native-view-at-point",
      { x: 50, y: 50 },
      "ViewHierarchy.viewAtPoint",
      { view: { className: "NSButton" } },
    ],
    [
      "native-user-interactable-view-at-point",
      { x: 50, y: 50 },
      "ViewHierarchy.userInteractableViewAtPoint",
      { view: { className: "NSButton" } },
    ],
  ])(
    "%s sends the iOS request to the library and keeps the iOS result shape",
    async (id, args, method, reply) => {
      const { invoke, calls, urns } = harness({ [method]: () => reply });
      const result = (await invoke(id, { bundleId: MAC_BUNDLE_ID, ...args })) as Record<
        string,
        unknown
      >;
      expect(result.status).toBe("ok");
      expect(result).toMatchObject(reply);
      // Waited for past the library's own 20 s limit.
      expect(calls.map((c) => [c.method, c.params, c.opts])).toEqual([
        [method, args, { timeoutMs: 22_000 }],
      ]);
      expect(urns).toEqual([MAC_URN]);
      expect(ensureDeps).not.toHaveBeenCalled();
    }
  );

  it.each(["native-describe-screen", "native-network-logs"])(
    "%s refuses a bundle id that is not the device's app",
    async (id) => {
      const { invoke, calls } = harness();
      const err = await errorOf(invoke(id, { bundleId: "com.example.Other" }));
      expect(err?.message).toMatch(/macos-app-com\.example\.Other/);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH);
      expect(calls).toEqual([]);
    }
  );
});

import { afterEach, describe, expect, it } from "vitest";
import { makeComponentTreeScript } from "../../src/utils/debugger/scripts/component-tree";

/**
 * `makeComponentTreeScript` returns a self-contained async IIFE injected via
 * Runtime.evaluate. Eval it against a mock `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`
 * to verify it:
 *   1. selects the renderer that hosts the real UI rather than assuming
 *      DevTools renderer id 1 (apps with a secondary reconciler such as
 *      react-native-skia register their own renderer, often at id 1), and
 *   2. measures layout via the public host instance (`measureInWindow`) when the
 *      global `nativeFabricUIManager` is an empty object — the bridgeless case
 *      where `nativeFabricUIManager.measure` does not exist.
 *
 * Regression harness for software-mansion/argent#316. Style mirrors
 * test/react-profiler/scripts-multi-renderer.test.ts.
 */

type Rect = { x: number; y: number; w: number; h: number };

function hostFiber(nativeTag: number, rect: Rect, opts: { withPublicInstance?: boolean } = {}) {
  const measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) =>
    cb(rect.x, rect.y, rect.w, rect.h);
  const canonical: Record<string, unknown> = { nativeTag };
  if (opts.withPublicInstance !== false) canonical.publicInstance = { measureInWindow };
  return {
    type: "RCTView",
    stateNode: { node: {}, canonical },
    memoizedProps: {},
    child: null,
    sibling: null,
  };
}

function comp(displayName: string, testID: string, child: unknown, sibling: unknown = null) {
  return { type: { displayName }, memoizedProps: { testID }, child, sibling };
}

function rootOf(childFiber: unknown) {
  return {
    current: { type: null, stateNode: null, memoizedProps: null, child: childFiber, sibling: null },
  };
}

function makeHook(rootsByRenderer: Record<number, unknown[]>) {
  const renderers = new Map<number, unknown>();
  for (const id of Object.keys(rootsByRenderer)) renderers.set(Number(id), {});
  return { renderers, getFiberRoots: (id: number) => new Set(rootsByRenderer[id] ?? []) };
}

async function runScript(
  hook: unknown,
  nativeFabricUIManager: unknown
): Promise<{ result: string } | null> {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    hook: g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    nf: g.nativeFabricUIManager,
    cb: g.__argent_callback,
    r: g.__r,
  };
  let captured: { result: string } | null = null;
  g.window = g;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  g.nativeFabricUIManager = nativeFabricUIManager;
  g.__r = function () {}; // metro require stub; the Dimensions block is try/caught
  g.__argent_callback = (payload: string) => {
    captured = JSON.parse(payload);
  };
  try {
    // indirect eval keeps access to the globalThis the script reads
    await (0, eval)(makeComponentTreeScript({ requestId: "t" }));
    return captured;
  } finally {
    g.window = saved.window;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved.hook;
    g.nativeFabricUIManager = saved.nf;
    g.__argent_callback = saved.cb;
    g.__r = saved.r;
  }
}

function components(captured: { result: string } | null) {
  expect(captured).toBeTruthy();
  return JSON.parse(captured!.result).components as Array<{
    name: string;
    testID?: string;
    rect: Rect | null;
  }>;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.nativeFabricUIManager;
  delete g.__argent_callback;
  delete g.__r;
});

describe("makeComponentTreeScript — multi-renderer renderer selection (argent#316)", () => {
  it("walks the renderer with the real UI, not a secondary reconciler at id 1", async () => {
    // Secondary reconciler (skia-like) registered at id 1 with a small subtree;
    // the real react-native UI lives in a larger root under id 3.
    const rn = rootOf(
      comp(
        "MyButton",
        "button",
        hostFiber(1, { x: 10, y: 20, w: 100, h: 40 }),
        comp("MyLabel", "label", hostFiber(2, { x: 10, y: 70, w: 100, h: 30 }))
      )
    );
    const skia = rootOf(comp("SkiaCircle", "skia-only", hostFiber(9, { x: 0, y: 0, w: 5, h: 5 })));
    const hook = makeHook({ 1: [skia], 3: [rn] });

    const comps = components(await runScript(hook, {}));
    const ids = comps.map((c) => c.testID);
    expect(ids).toContain("button");
    expect(ids).toContain("label");
    expect(ids).not.toContain("skia-only");
  });

  it("smoke: single-renderer app still works", async () => {
    const rn = rootOf(comp("MyButton", "button", hostFiber(1, { x: 1, y: 2, w: 3, h: 4 })));
    const comps = components(await runScript(makeHook({ 1: [rn] }), {}));
    expect(comps.map((c) => c.testID)).toContain("button");
  });
});

describe("makeComponentTreeScript — Fabric layout (argent#316)", () => {
  it("measures via publicInstance.measureInWindow when nativeFabricUIManager is empty (bridgeless)", async () => {
    const rn = rootOf(comp("MyButton", "button", hostFiber(1, { x: 10, y: 20, w: 100, h: 40 })));
    // {} → useFabric is true but there is no .measure; the public instance path must be used.
    const comps = components(await runScript(makeHook({ 3: [rn] }), {}));
    const btn = comps.find((c) => c.testID === "button");
    expect(btn?.rect).toEqual({ x: 10, y: 20, w: 100, h: 40 });
  });

  it("falls back to nativeFabricUIManager.measure when there is no publicInstance", async () => {
    const rn = rootOf(
      comp(
        "MyButton",
        "button",
        hostFiber(1, { x: 0, y: 0, w: 0, h: 0 }, { withPublicInstance: false })
      )
    );
    const nf = {
      measure: (
        _node: unknown,
        cb: (x: number, y: number, w: number, h: number, px: number, py: number) => void
      ) => cb(0, 0, 100, 40, 11, 22),
    };
    const comps = components(await runScript(makeHook({ 3: [rn] }), nf));
    const btn = comps.find((c) => c.testID === "button");
    expect(btn?.rect).toEqual({ x: 11, y: 22, w: 100, h: 40 });
  });
});

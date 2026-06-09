import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInspectScript } from "../../src/utils/debugger/scripts/inspect-at-point";

/**
 * `makeInspectScript` returns a self-contained IIFE injected via Runtime.evaluate.
 * Eval it against a mock `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` to verify it runs
 * getInspectorDataForViewAtPoint against the renderer that hosts the real UI rather
 * than assuming the first-registered renderer / id 1 — apps with a secondary
 * reconciler (react-native-skia, react-native-svg, …) register their own renderer,
 * often at id 1, whose roots contain only that library's nodes.
 *
 * Regression harness for software-mansion/argent#317. Style mirrors
 * test/react-profiler/scripts-multi-renderer.test.ts.
 */

function hostFiber(publicInstance: unknown) {
  return { type: "RCTView", stateNode: { node: {}, canonical: { nativeTag: 1, publicInstance } }, child: null, sibling: null };
}

function comp(displayName: string, child: unknown, sibling: unknown = null) {
  return { type: { displayName }, child, sibling };
}

function rootOf(childFiber: unknown) {
  return { current: { type: null, stateNode: null, child: childFiber, sibling: null } };
}

/** A renderer interface whose getInspectorDataForViewAtPoint is a spy. */
function makeRenderer(closestInstance: unknown) {
  const fn = vi.fn((_ref: unknown, _x: number, _y: number, cb: (data: unknown) => void) =>
    cb({ closestInstance })
  );
  return { renderer: { rendererConfig: { getInspectorDataForViewAtPoint: fn } }, fn };
}

function makeHook(entries: Array<[number, unknown, unknown[]]>) {
  const renderers = new Map<number, unknown>();
  const rootsById = new Map<number, unknown[]>();
  for (const [id, ri, roots] of entries) {
    renderers.set(id, ri);
    rootsById.set(id, roots);
  }
  return { renderers, getFiberRoots: (id: number) => new Set(rootsById.get(id) ?? []) };
}

function runInspect(hook: unknown): { type: string; items?: Array<{ name: string }>; error?: string } | null {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    hook: g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    nf: g.nativeFabricUIManager,
    cb: g.__argent_callback,
  };
  let captured: { type: string } | null = null;
  g.window = g;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  g.nativeFabricUIManager = {}; // useFabric true → findHostFiber uses stateNode.node
  g.__argent_callback = (payload: string) => { captured = JSON.parse(payload); };
  try {
    (0, eval)(makeInspectScript(50, 90, "t"));
    return captured;
  } finally {
    g.window = saved.window;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved.hook;
    g.nativeFabricUIManager = saved.nf;
    g.__argent_callback = saved.cb;
  }
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.nativeFabricUIManager;
  delete g.__argent_callback;
});

describe("makeInspectScript — multi-renderer renderer selection (argent#317)", () => {
  it("inspects against the renderer hosting the real UI, not a secondary reconciler at id 1", async () => {
    const rnPI = { __marker: "rn" };
    const rnRoot = rootOf(comp("MyButton", hostFiber(rnPI), comp("MyLabel", null)));
    const skiaRoot = rootOf(hostFiber({ __marker: "skia" }));

    const rn = makeRenderer(comp("MyButton", null)); // closestInstance fiber chain
    const skia = makeRenderer(comp("SkiaCircle", null));

    // skia registered at id 1 (the old hardcoded pick); real UI under id 3 with a bigger subtree
    const hook = makeHook([
      [1, skia.renderer, [skiaRoot]],
      [3, rn.renderer, [rnRoot]],
    ]);

    const out = runInspect(hook);

    expect(rn.fn).toHaveBeenCalledTimes(1);
    expect(skia.fn).not.toHaveBeenCalled();
    // inspectRef must be the RN host's public instance
    expect(rn.fn.mock.calls[0][0]).toBe(rnPI);
    expect(out?.type).toBe("inspect_result");
    expect(out?.items?.map((i) => i.name)).toContain("MyButton");
  });

  it("smoke: single-renderer app still inspects", async () => {
    const pi = { __marker: "only" };
    const rnRoot = rootOf(comp("Solo", hostFiber(pi)));
    const rn = makeRenderer(comp("Solo", null));
    const out = runInspect(makeHook([[1, rn.renderer, [rnRoot]]]));
    expect(rn.fn).toHaveBeenCalledTimes(1);
    expect(rn.fn.mock.calls[0][0]).toBe(pi);
    expect(out?.items?.map((i) => i.name)).toContain("Solo");
  });
});

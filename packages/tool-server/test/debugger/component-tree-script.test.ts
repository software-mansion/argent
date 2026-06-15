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

/**
 * Reproduces the Fabric tap-coordinate collapse bug at the injected-script
 * level (the existing component-tree.test.ts only tests the pure post-processor
 * with pre-filled rects, so it never exercised this path).
 *
 * Builds a minimal Fabric fiber tree of three sibling app components, each
 * wrapping a host RCTView whose shadow node is a DISTINCT object with a DISTINCT
 * nativeTag, measured at a DISTINCT on-screen position. The bug keyed the
 * per-host measure cache by the shadow-node OBJECT ("f" + node → "f[object
 * Object]" for every node), collapsing all hosts to one entry so every
 * component inherited the first host's rect — i.e. a (0.5, 0.5) tap for all.
 */

interface MeasuredRect {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
  py: number;
}

function buildFabricTree() {
  const rectByNode = new Map<object, MeasuredRect>();
  let nextTag = 100;

  function hostFiber(rect: MeasuredRect) {
    const node = {}; // a distinct Fabric shadow-node object per host
    rectByNode.set(node, rect);
    return {
      type: "RCTView",
      stateNode: { node, canonical: { nativeTag: ++nextTag } },
      memoizedProps: {},
      child: null,
      sibling: null,
    } as Record<string, unknown>;
  }

  function compFiber(name: string, rect: MeasuredRect, sibling: unknown) {
    const type = function () {} as { displayName?: string };
    type.displayName = name;
    return {
      type,
      stateNode: null,
      memoizedProps: { children: name },
      child: hostFiber(rect),
      sibling,
    } as Record<string, unknown>;
  }

  // Distinct vertical positions (px/py are what the script records).
  const compC = compFiber("CompC", { x: 0, y: 0, w: 200, h: 50, px: 10, py: 600 }, null);
  const compB = compFiber("CompB", { x: 0, y: 0, w: 200, h: 50, px: 10, py: 300 }, compC);
  const compA = compFiber("CompA", { x: 0, y: 0, w: 200, h: 50, px: 10, py: 100 }, compB);

  return { root: { current: { child: compA } }, rectByNode };
}

async function runInjectedScript() {
  const { root, rectByNode } = buildFabricTree();
  const script = makeComponentTreeScript({ requestId: "test", includeSkipped: false });

  let captured: { result: string } | undefined;
  const sandbox = {
    window: {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: { getFiberRoots: () => new Set([root]) },
    },
    nativeFabricUIManager: {
      measure(
        node: object,
        cb: (x: number, y: number, w: number, h: number, px: number, py: number) => void
      ) {
        const r = rectByNode.get(node)!;
        cb(r.x, r.y, r.w, r.h, r.px, r.py);
      },
    },
    __r: Object.assign(
      (_id: number) => ({ Dimensions: { get: () => ({ width: 400, height: 800 }) } }),
      {
        getModules: () => [[0, { isInitialized: true }]],
      }
    ),
    __argent_callback: (json: string) => {
      captured = JSON.parse(json);
    },
  };

  const runner = new Function(
    "window",
    "nativeFabricUIManager",
    "__r",
    "__argent_callback",
    `return ${script}`
  );
  await runner(
    sandbox.window,
    sandbox.nativeFabricUIManager,
    sandbox.__r,
    sandbox.__argent_callback
  );

  if (!captured) throw new Error("script did not invoke __argent_callback");
  return JSON.parse(captured.result) as {
    screenW: number;
    screenH: number;
    components: Array<{
      name: string;
      rect: { x: number; y: number; w: number; h: number } | null;
    }>;
  };
}

describe("makeComponentTreeScript — Fabric measurement", () => {
  it("gives each host its own measured rect instead of collapsing onto one", async () => {
    const result = await runInjectedScript();

    expect(result.screenW).toBe(400);
    expect(result.screenH).toBe(800);

    const comps = Object.fromEntries(result.components.map((c) => [c.name, c.rect]));
    expect(comps.CompA).toMatchObject({ y: 100 });
    expect(comps.CompB).toMatchObject({ y: 300 });
    expect(comps.CompC).toMatchObject({ y: 600 });

    // The regression: all three rects were identical (collapsed onto the first
    // host), which renders as the same centre-of-screen tap for every element.
    const distinctY = new Set(result.components.map((c) => c.rect?.y));
    expect(distinctY.size).toBe(3);
  });
});

describe("makeComponentTreeScript — Fabric hosts WITHOUT a numeric nativeTag (WeakMap fallback)", () => {
  // fabricKey() keys the per-host measure cache by 'f'+nativeTag, but when a
  // Fabric host has no numeric nativeTag it MUST fall back to a stable
  // WeakMap-by-identity id ('fo'+seq) so distinct shadow nodes never share a key.
  // Every other committed test gives its hosts numeric nativeTags, so they only
  // exercise the 'f'+tag fast path — yet the WeakMap fallback is the part that
  // actually prevents the "[object Object]" key collapse this PR fixes. Force it.
  function taglessHostFiber(rect: Rect) {
    const measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) =>
      cb(rect.x, rect.y, rect.w, rect.h);
    // canonical present (Fabric) but NO nativeTag -> fabricKey takes the WeakMap path.
    return {
      type: "RCTView",
      stateNode: { node: {}, canonical: { publicInstance: { measureInWindow } } },
      memoizedProps: {},
      child: null,
      sibling: null,
    };
  }

  it("gives each tagless Fabric host its own rect instead of collapsing onto one", async () => {
    const rn = rootOf(
      comp(
        "CardA",
        "a",
        taglessHostFiber({ x: 0, y: 10, w: 100, h: 40 }),
        comp(
          "CardB",
          "b",
          taglessHostFiber({ x: 0, y: 110, w: 100, h: 40 }),
          comp("CardC", "c", taglessHostFiber({ x: 0, y: 210, w: 100, h: 40 }))
        )
      )
    );
    // nativeFabricUIManager = {} (bridgeless) -> measurement runs through
    // publicInstance.measureInWindow, the same path real new-arch apps use.
    const comps = components(await runScript(makeHook({ 3: [rn] }), {}));
    const byId = Object.fromEntries(comps.map((c) => [c.testID, c.rect]));
    expect(byId.a).toEqual({ x: 0, y: 10, w: 100, h: 40 });
    expect(byId.b).toEqual({ x: 0, y: 110, w: 100, h: 40 });
    expect(byId.c).toEqual({ x: 0, y: 210, w: 100, h: 40 });
    // If the WeakMap fallback were broken (constant/absent key), all three would
    // collapse onto the first host's rect.
    const distinctY = new Set(comps.map((c) => c.rect?.y).filter((y) => y != null));
    expect(distinctY.size).toBe(3);
  });
});

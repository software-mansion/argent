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
  return {
    type: "RCTView",
    stateNode: { node: {}, canonical: { nativeTag: 1, publicInstance } },
    child: null,
    sibling: null,
  };
}

/**
 * Old-arch (Paper) host fiber as produced by RN 0.81 on the legacy bridge:
 * stateNode is a bare ReactNativeFiberHostComponent exposing _nativeTag and
 * _internalFiberInstanceHandleDEV directly, with NO `.canonical`. The stateNode
 * itself is the valid inspectedView for getInspectorDataForViewAtPoint.
 */
function paperHostFiber(nativeTag = 7) {
  return {
    type: "RCTView",
    stateNode: { _nativeTag: nativeTag, _internalFiberInstanceHandleDEV: {} },
    child: null,
    sibling: null,
  };
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

function runInspect(
  hook: unknown,
  opts: { fabric?: boolean } = {}
): {
  type: string;
  items?: Array<{ name: string; frame?: { file: string; line: number; col: number } | null }>;
  error?: string;
} | null {
  const fabric = opts.fabric ?? true;
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
  // useFabric is `typeof nativeFabricUIManager !== 'undefined'`. Defining it (even
  // as {}) selects the new-arch branch; deleting it selects the old-arch (Paper)
  // branch so findHostFiber must recognise stateNode._nativeTag host fibers.
  if (fabric) g.nativeFabricUIManager = {};
  else delete g.nativeFabricUIManager;
  g.__argent_callback = (payload: string) => {
    captured = JSON.parse(payload);
  };
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

describe("makeInspectScript — old-arch (Paper) host fiber resolution", () => {
  it("resolves a host fiber via stateNode._nativeTag when canonical is absent", () => {
    // Regression for inspect-element returning {"error":"no host fiber"} on RN
    // 0.81 / Hermes / old architecture, where host fibers expose _nativeTag
    // directly and have no stateNode.canonical.
    const host = paperHostFiber(42);
    const rnRoot = rootOf(comp("PaperButton", host, comp("PaperLabel", null)));
    const rn = makeRenderer(comp("PaperButton", null));

    const out = runInspect(makeHook([[1, rn.renderer, [rnRoot]]]), { fabric: false });

    expect(out?.error).toBeUndefined();
    expect(rn.fn).toHaveBeenCalledTimes(1);
    // Old-arch inspectedView is the ReactNativeFiberHostComponent stateNode
    // itself (carries _internalFiberInstanceHandleDEV + _nativeTag).
    expect(rn.fn.mock.calls[0][0]).toBe(host.stateNode);
    expect(out?.type).toBe("inspect_result");
    expect(out?.items?.map((i) => i.name)).toContain("PaperButton");
  });

  it("still prefers canonical.publicInstance on old-arch builds that expose it", () => {
    // Newer RN old-arch builds attach stateNode.canonical with a publicInstance;
    // that path must keep working (do not regress to passing the raw stateNode).
    const pi = { __marker: "paper-canonical" };
    const rnRoot = rootOf(comp("HybridButton", hostFiber(pi)));
    const rn = makeRenderer(comp("HybridButton", null));

    const out = runInspect(makeHook([[1, rn.renderer, [rnRoot]]]), { fabric: false });

    expect(out?.error).toBeUndefined();
    expect(rn.fn.mock.calls[0][0]).toBe(pi);
    expect(out?.items?.map((i) => i.name)).toContain("HybridButton");
  });
});

describe("makeInspectScript — RN 0.81 container anchor + componentStack", () => {
  it("anchors at the FiberRoot container and parses componentStack into items", () => {
    // RN 0.81 getInspectorDataForViewAtPoint returns a componentStack STRING and
    // no closestInstance; findSubviewIn only resolves when anchored at the root
    // container, not the first host fiber. Mirrors the shapes observed live.
    const B = "http://10.0.2.2:8081/index.bundle//&platform=android";
    const stack = [
      "    at RCTView (<anonymous>)",
      "    at View (" + B + ":10685:19)",
      "    at AnimatedComponent(View) (" + B + ":125621:37)",
      "    at hermesInternal (address at http://x/InternalBytecode.js:1:2)",
      "    at LoggedOut (" + B + ":200000:10)",
    ].join("\n");
    const fn = vi.fn((_ref: any, _x: number, _y: number, cb: (d: unknown) => void) =>
      cb({ componentStack: stack, closestInstance: undefined, hierarchy: [] })
    );
    const renderer = { rendererConfig: { getInspectorDataForViewAtPoint: fn } };
    // FiberRoot exposes containerInfo.containerTag (Paper); the child host fiber
    // must be IGNORED as the anchor in favor of the container.
    const root = {
      current: {
        type: null,
        stateNode: { containerInfo: { containerTag: 11 } },
        child: paperHostFiber(13),
        sibling: null,
      },
    };
    const hook = { renderers: new Map([[1, renderer]]), getFiberRoots: () => new Set([root]) };

    const out = runInspect(hook, { fabric: false });

    expect(out?.error).toBeUndefined();
    // Anchored at the container (tag 11), NOT the first host fiber (tag 13).
    expect((fn.mock.calls[0][0] as { _nativeTag: number })._nativeTag).toBe(11);
    const names = out?.items?.map((i) => i.name);
    expect(names).toEqual(["View", "AnimatedComponent(View)", "LoggedOut"]);
    expect(names).not.toContain("RCTView"); // host primitive (<anonymous>) dropped
    expect(names).not.toContain("hermesInternal"); // Hermes bytecode frame dropped
    const loggedOut = out?.items?.find((i) => i.name === "LoggedOut");
    expect(loggedOut?.frame).toMatchObject({ file: B, line: 200000, col: 10 });
  });
});

describe("makeInspectScript — Fabric host fiber with unrealized public instance", () => {
  it("passes canonical.publicInstance as-is (even null) on Fabric, never the raw stateNode", () => {
    // On Fabric the publicInstance is realized lazily, so a freshly-mounted host
    // fiber can legitimately have canonical.publicInstance === null. A raw stateNode
    // is NOT a valid inspectedView on Fabric -- the renderer logs and never invokes
    // the callback, hanging the inspect request. The _nativeTag raw-stateNode
    // fallback is old-arch only; on any canonical path we hand back publicInstance
    // exactly as the pre-fix code did (null fast-fails into our try/catch).
    const host = hostFiber(null); // Fabric stateNode: { node, canonical: { publicInstance: null } }
    const rnRoot = rootOf(comp("FreshButton", host));
    const rn = makeRenderer(comp("FreshButton", null));

    runInspect(makeHook([[1, rn.renderer, [rnRoot]]])); // fabric: true (default)

    expect(rn.fn).toHaveBeenCalledTimes(1);
    expect(rn.fn.mock.calls[0][0]).toBe(null);
    expect(rn.fn.mock.calls[0][0]).not.toBe(host.stateNode);
  });
});

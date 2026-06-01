import { describe, it, expect } from "vitest";
import { makeComponentTreeScript } from "../../src/utils/debugger/scripts/component-tree";

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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
  py: number;
}

function buildFabricTree() {
  const rectByNode = new Map<object, Rect>();
  let nextTag = 100;

  function hostFiber(rect: Rect) {
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

  function compFiber(name: string, rect: Rect, sibling: unknown) {
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
    __r: Object.assign((_id: number) => ({ Dimensions: { get: () => ({ width: 400, height: 800 }) } }), {
      getModules: () => [[0, { isInitialized: true }]],
    }),
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
  await runner(sandbox.window, sandbox.nativeFabricUIManager, sandbox.__r, sandbox.__argent_callback);

  if (!captured) throw new Error("script did not invoke __argent_callback");
  return JSON.parse(captured.result) as {
    screenW: number;
    screenH: number;
    components: Array<{ name: string; rect: { x: number; y: number; w: number; h: number } | null }>;
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

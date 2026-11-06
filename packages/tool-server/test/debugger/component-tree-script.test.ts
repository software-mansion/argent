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

describe("makeComponentTreeScript — Fabric measurement via nativeFabricUIManager.measure", () => {
  // Companion to the WeakMap-fallback test below, but on the OTHER measure path:
  // when a Fabric host has no publicInstance, measurement falls through to
  // nativeFabricUIManager.measure(shadowNode). The shadow node is an OBJECT, so
  // the old cache key ('f' + node) stringified every node to "f[object Object]",
  // collapsing all hosts to one entry — every component inherited the first
  // host's rect (a 0.5,0.5 tap for all). Hosts here are intentionally TAGLESS so
  // the cache key falls to the WeakMap-by-identity path this PR adds; with a
  // numeric nativeTag the buggy key was already distinct and never collapsed.
  function taglessFabricHost(node: object) {
    // canonical present (Fabric) but NO nativeTag and NO publicInstance ->
    // measurement uses nativeFabricUIManager.measure(node).
    return {
      type: "RCTView",
      stateNode: { node, canonical: {} },
      memoizedProps: {},
      child: null,
      sibling: null,
    };
  }

  it("gives each tagless host its own rect via measure() instead of collapsing onto one", async () => {
    const nodeA = {};
    const nodeB = {};
    const nodeC = {};
    // px/py are what measure() reports as the on-screen position the script records.
    const rectByNode = new Map<object, { x: number; y: number; w: number; h: number }>([
      [nodeA, { x: 10, y: 100, w: 200, h: 50 }],
      [nodeB, { x: 10, y: 300, w: 200, h: 50 }],
      [nodeC, { x: 10, y: 600, w: 200, h: 50 }],
    ]);
    const rn = rootOf(
      comp(
        "CompA",
        "a",
        taglessFabricHost(nodeA),
        comp("CompB", "b", taglessFabricHost(nodeB), comp("CompC", "c", taglessFabricHost(nodeC)))
      )
    );
    const nf = {
      measure: (
        node: object,
        cb: (x: number, y: number, w: number, h: number, px: number, py: number) => void
      ) => {
        const r = rectByNode.get(node)!;
        cb(0, 0, r.w, r.h, r.x, r.y);
      },
    };

    const comps = components(await runScript(makeHook({ 3: [rn] }), nf));
    const byId = Object.fromEntries(comps.map((c) => [c.testID, c.rect]));
    expect(byId.a).toEqual({ x: 10, y: 100, w: 200, h: 50 });
    expect(byId.b).toEqual({ x: 10, y: 300, w: 200, h: 50 });
    expect(byId.c).toEqual({ x: 10, y: 600, w: 200, h: 50 });
    // The regression: all three rects were identical (collapsed onto the first
    // host), which renders as the same centre-of-screen tap for every element.
    const distinctY = new Set(comps.map((c) => c.rect?.y).filter((y) => y != null));
    expect(distinctY.size).toBe(3);
  });
});

describe("makeComponentTreeScript — screens that are not on view", () => {
  type Fiber = {
    type: unknown;
    key?: string | null;
    memoizedProps: Record<string, unknown> | null;
    stateNode?: unknown;
    child: Fiber | null;
    sibling: Fiber | null;
  };

  let nextTag = 1;

  /** A fiber whose children are linked through child/sibling. */
  function fiber(
    type: unknown,
    props: Record<string, unknown> | null,
    children: Fiber[] = [],
    key: string | null = null
  ): Fiber {
    for (let i = 0; i < children.length - 1; i++) children[i].sibling = children[i + 1];
    return { type, key, memoizedProps: props, child: children[0] ?? null, sibling: null };
  }

  /** An app component with a testID over its own measurable host view. */
  function view(testID: string, props: Record<string, unknown> = {}) {
    const host = hostFiber(nextTag++, { x: 0, y: 100, w: 402, h: 50 }) as Fiber;
    return fiber({ displayName: "AppView" }, { testID, ...props }, [host]);
  }

  /**
   * One native-stack route as @react-navigation/native-stack 7 renders it:
   * SceneView → NavigationProvider and three context providers →
   * ScreenStackItem (a forwardRef, no name) → Screen → the route's content.
   * On Bluesky the ScreenStackItem sits 5 fibers below the SceneView too.
   * `screenProps` are the ScreenStackItem's.
   */
  function route(key: string, screenProps: Record<string, unknown>, content: Fiber[]) {
    const screen = fiber({ displayName: "Screen" }, screenProps, content);
    const item = fiber({ render: () => null }, screenProps, [screen]);
    let providers = item;
    for (let i = 0; i < 3; i++) providers = fiber({ _context: {} }, { value: {} }, [providers]);
    const provider = fiber({ name: "NavigationProvider" }, {}, [providers]);
    return fiber({ name: "SceneView" }, { focused: false }, [provider], key);
  }

  /** v7.3.x and later: aria-hidden on every route but the top one. */
  function v7Route(
    key: string,
    opts: { hidden: boolean; presentation?: string; activityState?: number },
    content: Fiber[]
  ) {
    return route(
      key,
      {
        "screenId": key,
        "activityState": opts.activityState ?? 2,
        "aria-hidden": opts.hidden,
        "stackPresentation": opts.presentation ?? "push",
      },
      content
    );
  }

  function stack(routes: Fiber[]) {
    return fiber("RNSScreenStack", {}, routes);
  }

  async function testIDs(...topLevel: Fiber[]) {
    const appRoot = fiber({ displayName: "App" }, {}, topLevel);
    const comps = components(await runScript(makeHook({ 1: [rootOf(appRoot)] }), {}));
    return comps.map((c) => c.testID).filter(Boolean);
  }

  it("prunes a native-stack route under a pushed one, and keeps the top route and the tab bar", async () => {
    // Bluesky, Settings → Account: Settings stays mounted at activityState 2 with
    // aria-hidden true; its rows used to come out with tap points over Account's.
    const ids = await testIDs(
      stack([
        v7Route("Settings", { hidden: true }, [view("settings-row")]),
        v7Route("Account", { hidden: false }, [view("account-row")]),
      ]),
      view("tab-bar")
    );
    expect(ids).toEqual(["account-row", "tab-bar"]);
  });

  it("prunes covered routes of native-stack 7.0–7.3, which mark them accessibilityElementsHidden", async () => {
    const older = (key: string, focused: boolean, content: Fiber[]) =>
      route(
        key,
        {
          screenId: key,
          activityState: 2,
          accessibilityElementsHidden: !focused,
          importantForAccessibility: focused ? "auto" : "no-hide-descendants",
          stackPresentation: "push",
        },
        content
      );
    const ids = await testIDs(
      stack([older("Home", false, [view("home-feed")]), older("Thread", true, [view("thread")])])
    );
    expect(ids).toEqual(["thread"]);
  });

  /**
   * react-native-screens before 4.4 wrapped each route of a ScreenStack in
   * DelayedFreeze → Freeze → Suspense → Offscreen → Suspender.
   */
  function frozenWrap(routeFiber: Fiber) {
    const suspender = fiber({ name: "Suspender" }, { freeze: false }, [routeFiber]);
    const offscreen = fiber({}, { mode: "visible" }, [suspender]);
    const suspense = fiber({}, {}, [offscreen]);
    const freeze = fiber({ name: "Freeze" }, { freeze: false }, [suspense]);
    return fiber({ name: "DelayedFreeze" }, { freeze: false }, [freeze], routeFiber.key);
  }

  it("prunes covered routes of native-stack 6, whose Screen has no activityState, screenId or aria-hidden", async () => {
    // native-stack 6.9.2+ hides an unfocused route from accessibility on a plain
    // View inside the Screen, and 6.0–6.9.1 not at all, so only the route order
    // tells the covered route apart.
    const v6 = (key: string, focused: boolean, content: Fiber[]) =>
      frozenWrap(
        fiber(
          { name: "SceneView" },
          { focused },
          [
            fiber(
              { displayName: "Screen" },
              { enabled: true, isNativeStack: true, stackPresentation: "push" },
              [
                fiber(
                  "RCTView",
                  {
                    accessibilityElementsHidden: !focused,
                    importantForAccessibility: focused ? "auto" : "no-hide-descendants",
                  },
                  content
                ),
              ]
            ),
          ],
          key
        )
      );
    const ids = await testIDs(
      stack([v6("Home", false, [view("home-feed")]), v6("Thread", true, [view("thread")])])
    );
    expect(ids).toEqual(["thread"]);
  });

  it("finds the screen of a route wrapped in react-native-screens' freeze fibers", async () => {
    const ids = await testIDs(
      stack([
        frozenWrap(v7Route("Home", { hidden: true }, [view("home-feed")])),
        frozenWrap(v7Route("Thread", { hidden: false }, [view("thread")])),
      ])
    );
    expect(ids).toEqual(["thread"]);
  });

  it.each(["transparentModal", "containedTransparentModal", "formSheet"])(
    "keeps the route under a %s, which leaves it on view",
    async (presentation) => {
      const ids = await testIDs(
        stack([
          v7Route("Home", { hidden: true }, [view("home-feed")]),
          v7Route("Sheet", { hidden: false, presentation }, [view("sheet")]),
        ])
      );
      expect(ids).toEqual(["home-feed", "sheet"]);
    }
  );

  it.each(["modal", "pageSheet", "fullScreenModal", "containedModal"])(
    "prunes the route under a %s",
    async (presentation) => {
      const ids = await testIDs(
        stack([
          v7Route("Home", { hidden: true }, [view("home-feed")]),
          v7Route("Modal", { hidden: false, presentation }, [view("modal")]),
        ])
      );
      expect(ids).toEqual(["modal"]);
    }
  );

  it("keeps a route under a form sheet but not the routes an opaque route covers", async () => {
    const ids = await testIDs(
      stack([
        v7Route("Home", { hidden: true }, [view("home-feed")]),
        v7Route("Details", { hidden: true }, [view("details")]),
        v7Route("Sheet", { hidden: false, presentation: "formSheet" }, [view("sheet")]),
      ])
    );
    expect(ids).toEqual(["details", "sheet"]);
  });

  it("prunes routes under a screen pushed over a transparent modal", async () => {
    const ids = await testIDs(
      stack([
        v7Route("Home", { hidden: true }, [view("home-feed")]),
        v7Route("Overlay", { hidden: true, presentation: "transparentModal" }, [view("overlay")]),
        v7Route("Details", { hidden: false }, [view("details")]),
      ])
    );
    expect(ids).toEqual(["details"]);
  });

  it("does not let a preloaded route (activityState 0) cover the top route", async () => {
    const ids = await testIDs(
      stack([
        v7Route("Home", { hidden: true }, [view("home-feed")]),
        v7Route("Thread", { hidden: false }, [view("thread")]),
        v7Route("Preloaded", { hidden: true, activityState: 0 }, [view("preloaded")]),
      ])
    );
    expect(ids).toEqual(["thread"]);
  });

  it("keeps a stack's only route even when it is marked hidden", async () => {
    const ids = await testIDs(stack([v7Route("Home", { hidden: true }, [view("home-feed")])]));
    expect(ids).toEqual(["home-feed"]);
  });

  it("prunes per stack in nested navigators", async () => {
    // Root stack [Tabs, Details]: the tab navigator (with its own stack and tab
    // bar) is covered by Details. Inside Details, a nested stack [List, Item].
    const tabs = v7Route("Tabs", { hidden: true }, [
      stack([v7Route("Feed", { hidden: false }, [view("feed")])]),
      view("tab-bar"),
    ]);
    const details = v7Route("Details", { hidden: false }, [
      stack([
        v7Route("List", { hidden: true }, [view("list")]),
        v7Route("Item", { hidden: false }, [view("item")]),
      ]),
    ]);
    const ids = await testIDs(stack([tabs, details]));
    expect(ids).toEqual(["item"]);
  });

  it("keeps the stack of the focused tab under a tab bar, and prunes it per route", async () => {
    // Bluesky's layout: bottom tabs outside, a native stack in each tab.
    const focusedTab = fiber({ displayName: "Screen" }, { activityState: 2 }, [
      stack([
        v7Route("Home", { hidden: true }, [view("home-feed")]),
        v7Route("Thread", { hidden: false }, [view("thread")]),
      ]),
    ]);
    const inactiveTab = fiber({ displayName: "Screen" }, { activityState: 0 }, [
      stack([v7Route("Search", { hidden: false }, [view("search")])]),
    ]);
    const ids = await testIDs(
      fiber("RNSScreenContainer", {}, [focusedTab, inactiveTab]),
      view("tab-bar")
    );
    expect(ids).toEqual(["thread", "tab-bar"]);
  });

  it("keeps views that the app hides from accessibility", async () => {
    // Apps set these on decorative views that are on view (Bluesky's icons).
    const ids = await testIDs(
      view("aria-hidden", { "aria-hidden": true }),
      view("a11y-hidden", {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      }),
      view("visible-screen-content")
    );
    expect(ids).toEqual(["aria-hidden", "a11y-hidden", "visible-screen-content"]);
  });

  it("still prunes activityState 0 and 1 and isPageFocused false, and keeps activityState 2", async () => {
    const ids = await testIDs(
      fiber({ displayName: "Screen" }, { activityState: 0 }, [view("inactive")]),
      fiber({ displayName: "Screen" }, { activityState: 1 }, [view("transitioning")]),
      fiber({ displayName: "Screen" }, { activityState: 2 }, [view("active")]),
      fiber({ displayName: "FeedPage" }, { isPageFocused: false }, [view("other-page")]),
      fiber({ displayName: "FeedPage" }, { isPageFocused: true }, [view("this-page")])
    );
    expect(ids).toEqual(["active", "this-page"]);
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

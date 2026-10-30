import { vi } from "vitest";
import type { Registry } from "@argent/registry";
import { macosAppRef, type MacosAppApi } from "../../src/blueprints/macos-app";
import { resolveDevice } from "../../src/utils/device-info";

/** A fake in-app library for the macOS tree tests, serving the probe app below. */

export const MACOS_DEVICE_ID = "macos-app-com.argent.probe";
export const MACOS_BUNDLE_ID = "com.argent.probe";

type Json = Record<string, unknown>;

export const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

/** One `Accessibility.getTree` node. */
export function axNode(role: string, frame: Json, attrs: Json = {}, children: Json[] = []): Json {
  return { role, normalizedFrame: frame, ...attrs, children };
}

/**
 * The probe app's `Accessibility.getTree` result, in fractions of its window:
 * native controls, a scroll view showing 8 of its 30 rows (the frames of rows 9
 * to 23 still fall inside the window), a popup button's menu hanging below the
 * scroll view it opened in, a web view (see {@link probeWeb}), a button outside
 * the window, and React Native views. `dead` makes `swift.dead` an element that
 * did not answer.
 */
export function probeTree(opts: { dead?: boolean } = {}): Json {
  const ax = axNode;
  const rows = Array.from({ length: 30 }, (_, i) => {
    const y = 0.269 + i * 0.031646;
    const text = ax("AXStaticText", rect(0.027, y + 0.003, 0.222, 0.025), {
      value: `row ${i + 1}`,
    });
    const cell = ax("AXCell", rect(0.022, y, 0.428, 0.0316), {}, [text]);
    return ax("AXRow", rect(0.022, y, 0.428, 0.0316), {}, [cell]);
  });
  const items = ["Red", "Green", "Blue", "Purple"].map((title, i) =>
    ax("AXMenuItem", rect(0.511, 0.3228 + i * 0.0348, 0.167, 0.0348), { title })
  );
  const id = (identifier: string, attrs: Json = {}) => ({ identifier, ...attrs });
  const root = ax("AXWindow", rect(0, 0, 1, 1), { title: "Probe", focused: true }, [
    ax("AXButton", rect(0.009, 0.009, 0.016, 0.022), { subrole: "AXCloseButton" }),
    ax("AXStaticText", rect(0.444, 0.009, 0.111, 0.025), { value: "Probe" }),
    ax(
      "AXTextField",
      rect(0.022, 0.063, 0.333, 0.038),
      id("appkit.field", { value: "hello", focused: true })
    ),
    ax(
      "AXTextField",
      rect(0.378, 0.063, 0.222, 0.038),
      id("appkit.secure", { subrole: "AXSecureTextField", value: "•••••••" })
    ),
    ax(
      "AXTextField",
      rect(0.022, 0.114, 0.333, 0.038),
      id("swift.field", { description: "SwiftUI field", value: "" })
    ),
    ax(
      "AXCheckBox",
      rect(0.022, 0.165, 0.178, 0.028),
      id("appkit.checkbox", { title: "AppKit checkbox", value: "0" })
    ),
    ax(
      "AXCheckBox",
      rect(0.222, 0.165, 0.044, 0.035),
      id("swift.toggle", { description: "SwiftUI toggle", value: "1" })
    ),
    ax("AXButton", rect(0.022, 0.209, 0.111, 0.038), id("appkit.button", { title: "Tap me" })),
    ax("AXSlider", rect(0.156, 0.209, 0.222, 0.038), id("appkit.slider", { value: "0" })),
    ax("AXStaticText", rect(0.4, 0.209, 0.089, 0.025), { value: "taps 0" }),
    ax("AXButton", rect(0.511, 0.209, 0.089, 0.038), { title: "Disabled", enabled: false }),
    ax("AXScrollArea", rect(0.022, 0.269, 0.444, 0.2373), id("appkit.scroll"), [
      ax("AXTable", rect(0.022, 0.269, 0.428, 0.949), id("appkit.table"), rows),
      ax("AXScrollBar", rect(0.45, 0.269, 0.017, 0.237), { value: "0" }, [
        ax("AXValueIndicator", rect(0.452, 0.272, 0.012, 0.047), { value: "0" }),
        ax("AXButton", rect(0.452, 0.32, 0.012, 0.187), { subrole: "AXIncrementPage" }),
        ax("AXButton", rect(0.451, 0.269, 0, 0), { subrole: "AXDecrementArrow" }),
      ]),
    ]),
    ax("AXScrollArea", rect(0.5, 0.269, 0.478, 0.1582), id("settings.scroll"), [
      ax("AXGroup", rect(0.5, 0.269, 0.478, 0.1582), {}, [
        ax(
          "AXPopUpButton",
          rect(0.511, 0.285, 0.133, 0.038),
          id("appkit.popup", { title: "Color", value: "Red" }),
          [ax("AXMenu", rect(0.511, 0.3228, 0.167, 0.1392), {}, items)]
        ),
      ]),
    ]),
    ax("AXGroup", rect(0.022, 0.538, 0.956, 0.3165), { webView: 0 }),
    ax(
      "AXButton",
      rect(0.667, 0.949, 0.056, 0.032),
      id("swift.dead", opts.dead ? { unreachable: true } : { title: "Dead button" })
    ),
    ax(
      "AXButton",
      rect(1.056, 0.475, 0.089, 0.038),
      id("appkit.offscreen", { title: "Offscreen" })
    ),
  ]);
  const view = (identifier: string, text: string, subtreeText: string, visible: Json | null) => ({
    identifier,
    class: "RCTViewComponentView",
    text,
    subtreeText,
    visibleNormalizedFrame: visible,
  });
  return {
    truncated: false,
    unreachableCount: opts.dead ? 1 : 0,
    windows: [{ kind: "window", root }],
    extraViews: [
      view("rn.text", "Static text", "", rect(0.022, 0.886, 0.222, 0.032)),
      view("rn.box", "", "Box title Box body", rect(0.267, 0.886, 0.111, 0.063)),
      // Below the window: nothing of it shows.
      view("rn.far", "Far away", "", null),
    ],
  };
}

/** One `Web.tree` item: the fields not given are empty, and `fullText` is `text`. */
function webItem(item: Json): Json {
  return {
    tag: "div",
    id: "",
    testid: "",
    label: "",
    role: "",
    type: "",
    text: "",
    fullText: item.text ?? "",
    ownText: "",
    placeholder: "",
    value: null,
    disabled: false,
    focused: false,
    checked: false,
    ...item,
  };
}

/** A `Web.tree` result for web view 0. */
export function webTree(items: Json[]): Json {
  return { webView: 0, truncated: false, items: items.map(webItem) };
}

/** The items of the probe app's web view, which lies at (0.022, 0.538, 0.956, 0.317). */
export function probeWeb(): Json {
  const at = (x: number, y: number, width: number, height: number, item: Json) => ({
    normalizedFrame: rect(x, y, width, height),
    ...item,
  });
  const own = (text: string) => ({ text, ownText: text });
  return webTree([
    at(0.033, 0.554, 0.133, 0.047, { tag: "button", testid: "web-button", ...own("Web button") }),
    at(0.178, 0.554, 0.222, 0.047, {
      tag: "input",
      type: "text",
      testid: "web-input",
      text: "Type here",
      placeholder: "Type here",
      value: "",
    }),
    at(0.411, 0.554, 0.222, 0.047, {
      tag: "input",
      type: "password",
      id: "web-pass",
      text: "hunter2",
      fullText: "",
      value: "hunter2",
    }),
    at(0.644, 0.562, 0.022, 0.032, {
      tag: "input",
      type: "checkbox",
      testid: "web-check",
      value: "on",
      checked: true,
    }),
    at(0.689, 0.562, 0.044, 0.032, { tag: "a", id: "web-link", ...own("Docs") }),
    at(0.911, 0.554, 0.044, 0.047, { role: "button", label: "Close banner" }),
    at(0.033, 0.617, 0.111, 0.038, {
      tag: "select",
      testid: "web-select",
      text: "A\nB\nC",
      value: "b",
    }),
    // Below the web view's bottom edge.
    at(0.033, 0.902, 0.333, 0.032, { tag: "li", testid: "web-row-hidden", ...own("Hidden row") }),
    at(0.033, 0.68, 0.444, 0.095, {
      testid: "web-summary",
      text: `Order summary: ${"x".repeat(65)}`,
      fullText: `Order summary: ${"x".repeat(70)} TOTAL 42`,
    }),
    at(0.489, 0.617, 0.333, 0.095, {
      tag: "textarea",
      testid: "web-notes",
      text: `${"A".repeat(50)} ${"B".repeat(29)}`,
      placeholder: "Notes",
      value: `${"A".repeat(50)} ${"B".repeat(49)}`,
    }),
    at(0.033, 0.791, 0.333, 0.032, { tag: "p", ...own("Paragraph text") }),
    at(0.378, 0.791, 0.111, 0.032, { tag: "span", id: "web-status", ...own("Ready") }),
    at(0.033, 0.831, 0.333, 0.038, { tag: "h2", ...own("Section title") }),
    at(0.511, 0.791, 0.111, 0.047, { id: "web-anchor" }),
    at(0.644, 0.728, 0.222, 0.095, {
      testid: "web-address",
      text: "Line one Line two",
      fullText: "Line one\n\nLine   two",
    }),
  ]);
}

/** Depth-first search of a wire node tree. */
export function findWireNode(node: Json, pred: (n: Json) => boolean): Json | undefined {
  if (pred(node)) return node;
  for (const child of (node.children as Json[] | undefined) ?? []) {
    const hit = findWireNode(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

/** The first window's root node of a getTree result. */
export function windowRoot(tree: Json): Json {
  return (tree.windows as Array<{ root: Json }>)[0]!.root;
}

export interface FakeLibraryCall {
  method: string;
  params: Record<string, unknown> | undefined;
  at: number;
}

export interface FakeLibrary {
  api: MacosAppApi;
  calls: FakeLibraryCall[];
}

/**
 * `trees` are served one per `Accessibility.getTree` call, repeating the last;
 * an Error rejects that call. `web` answers `Web.tree`, or is an Error to
 * reject it with.
 */
export function fakeMacosLibrary(
  opts: { trees?: Array<Json | Error>; web?: Json | Error } = {}
): FakeLibrary {
  const trees = opts.trees ?? [probeTree()];
  const web = opts.web ?? probeWeb();
  const calls: FakeLibraryCall[] = [];
  let treeReads = 0;
  const api: MacosAppApi = {
    bundleId: MACOS_BUNDLE_ID,
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params, at: Date.now() });
      if (method === "Accessibility.getTree") {
        const tree = trees[Math.min(treeReads++, trees.length - 1)];
        if (tree instanceof Error) throw tree;
        return tree as T;
      }
      if (method === "Web.tree") {
        if (web instanceof Error) throw web;
        return web as T;
      }
      throw new Error(`fake library: unexpected method ${method}`);
    },
    launch: async () => {
      throw new Error("fake library: launch");
    },
    connect: async () => {},
    isConnected: () => true,
    handshake: () => ({ bundleId: MACOS_BUNDLE_ID, pid: 4242, platform: "macos", protocol: 1 }),
    activateNetworkInspection: async () => {},
    networkLog: () => [],
    clearNetworkLog: () => {},
  };
  return { api, calls };
}

/** A registry whose only service is the fake library. */
export function macosRegistry(api: MacosAppApi): Registry & {
  resolveService: ReturnType<typeof vi.fn>;
} {
  const { urn: appUrn } = macosAppRef(resolveDevice(MACOS_DEVICE_ID));
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn === appUrn) return api;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as unknown as Registry & { resolveService: ReturnType<typeof vi.fn> };
}

/** The describe contract's frame rule: four finite fractions in [0, 1]. */
export function isUnitFrame(frame: unknown): boolean {
  const f = frame as Record<string, unknown> | null;
  return (
    !!f &&
    ["x", "y", "width", "height"].every(
      (k) =>
        typeof f[k] === "number" &&
        Number.isFinite(f[k]) &&
        (f[k] as number) >= 0 &&
        (f[k] as number) <= 1
    )
  );
}

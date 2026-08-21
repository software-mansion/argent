import type { DescribeNode } from "../../contract";
import type { HarmonyLayoutNode } from "../../../../utils/harmony-uitest";
import { clipBoundsToScreen } from "../android/uiautomator-parser";

/**
 * Turn a `uitest dumpLayout` tree into the shared describe tree.
 *
 * The dump is ArkUI's component hierarchy, and it is shaped much like a
 * uiautomator dump — `[x1,y1][x2,y2]` bounds, `clickable`/`checkable` flags, a
 * `type` that plays the part of Android's `class` — so this mirrors the Android
 * trimmer's structure. It is markedly shorter for one measured reason: `uitest`
 * already merges the window stack and emits what is on screen, so a full
 * Settings list is 177 nodes and its one `visible: false` node is a zero-area
 * `ListItem`.
 *
 * What is deliberately NOT mirrored is the Android side's scroll clip. A `List`
 * rect is not a clip rect here: scroll that same Settings screen and its
 * "Log in to HUAWEI ID" row sits at y=164-308 while the `List` it belongs to
 * starts at y=332, still rendered (screenshot-checked) under the collapsing
 * title. Pruning by the scrolling ancestor's rect would drop six such nodes on
 * one scroll, every one of them visible and tappable.
 *
 * What it must handle that Android's does not:
 *
 * - **Every value is a string**, `"true"`/`"false"` included.
 * - **`description` is often a single space** rather than empty — the
 *   calculator's keypad labels every Button `" "`. Trimming is what stops each
 *   one becoming a blank-labelled node that reads as a real label.
 * - **Windows are top-level children**, each carrying `bundleName` /
 *   `abilityName`, so which app owns which subtree is knowable and worth
 *   surfacing.
 * - **`UIExtensionComponent` subtrees are USUALLY opaque — but not always.**
 *   System extension UI (the "open with" app selector, share sheets) renders in
 *   another process and the dump carries the node with no children; those are
 *   labelled so the emptiness reads as a fact. But on HarmonyOS 6.1.1 the same
 *   node can arrive with the FULL subtree — the HUAWEI ID login sheet carries
 *   its TextInput and both Buttons (45 nodes measured), and those targets are
 *   live (their geometry taps). Children win: a subtree that exists is parsed
 *   normally, and only a genuinely childless one is labelled opaque.
 */

/** Bounds arrive as `[left,top][right,bottom]`, in device pixels. */
export function parseHarmonyBounds(bounds: string): PixelRect | null {
  const m = /\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/.exec(bounds);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map((v) => Number.parseInt(v, 10));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const isTrue = (attrs: Record<string, string>, key: string): boolean => attrs[key] === "true";

/**
 * ArkUI layout primitives and framework scaffolding: real nodes in the tree,
 * but never a tap target and never worth a line of an agent's context. Walked
 * through rather than emitted, exactly as the Android trimmer treats
 * `FrameLayout`/`LinearLayout`.
 */
const LAYOUT_CONTAINERS = new Set([
  "",
  "Column",
  "Row",
  "Stack",
  "Flex",
  "RelativeContainer",
  "__Common__",
  "EffectComponent",
  "Navigation",
  "NavBar",
  "NavBarContent",
  "WindowScene",
  "root",
  "JsView",
]);

/**
 * Pure decoration with no label and no behaviour. Dropped outright rather than
 * walked through — unlike the containers above, these never carry a subtree
 * worth keeping.
 */
const DECORATIONS = new Set(["Divider", "ScrollBar", "metaballNode"]);

/**
 * Renders in another process, so the dump USUALLY carries the node and none of
 * its content. A childless one is kept and labelled, so the emptiness is
 * visible as a fact rather than as an absence. One that arrives WITH children
 * (measured on HarmonyOS 6.1.1) is parsed normally — see the header.
 */
const OPAQUE_EXTENSION = "UIExtensionComponent";

/** ArkUI containers that scroll their content. */
const SCROLL_TYPES = new Set(["List", "Grid", "Scroll", "Swiper", "WaterFlow"]);

function isScrollable(attrs: Record<string, string>): boolean {
  return SCROLL_TYPES.has(attrs.type ?? "") || isTrue(attrs, "scrollable");
}

/**
 * One attribute as trimmed text.
 *
 * The dump is `JSON.parse`d and asserted to be all-strings, which is measured
 * on 6.1.1 but not guaranteed by anything: a single numeric or boolean value
 * would otherwise throw a bare `TypeError` out of the parser and take the whole
 * `describe` down, with no failure signal, rather than costing one attribute.
 */
function attrText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The screen-reader-meaningful label.
 *
 * `description` (ArkUI's `accessibilityText`) wins over `text` for the same
 * reason `content-desc` does on Android: when both are set they describe
 * different things, and the contract carries the typed content separately as
 * `value`. `hint` is the placeholder of an empty field, which is the only label
 * such a field has.
 */
export function harmonyLabel(attrs: Record<string, string>): string {
  const description = attrText(attrs.description);
  if (description) return description;
  const text = attrText(attrs.text);
  if (text) return text;
  return attrText(attrs.hint);
}

interface HarmonyNode {
  role: string;
  pixelBounds: PixelRect | null;
  label?: string;
  identifier?: string;
  value?: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  disabled: boolean;
  focused: boolean;
  selected: boolean;
  children: HarmonyNode[];
}

/** A node with no size cannot be tapped and cannot be seen. */
function hasArea(b: PixelRect | null): boolean {
  return b !== null && b.w > 0 && b.h > 0;
}

function rectsEqual(a: PixelRect, b: PixelRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function build(node: HarmonyLayoutNode): HarmonyNode[] {
  const attrs = node.attributes ?? {};
  const type = attrs.type ?? "";
  const bounds = parseHarmonyBounds(attrs.bounds ?? "");
  const children = (node.children ?? []).flatMap(build);

  if (DECORATIONS.has(type)) return [];

  // Only a genuinely childless extension is opaque. One carrying a subtree is
  // real, live UI (its Buttons tap), so it falls through and is parsed like
  // anything else — replacing it with the placeholder would discard the only
  // controls that dismiss the sheet, and `uitest screenCap` does not capture
  // the surface either, so the agent would have nothing.
  if (type === OPAQUE_EXTENSION && children.length === 0) {
    return [
      {
        ...blank(attrs, bounds),
        role: "SystemOverlay",
        label:
          "[system UI rendered in another process — its contents are not in the layout dump; " +
          "screenshot to see it]",
        children: [],
      },
    ];
  }

  const label = harmonyLabel(attrs);

  if (!hasArea(bounds) && children.length === 0) return [];

  const own: HarmonyNode = {
    ...blank(attrs, bounds),
    role: deriveRole(type, attrs),
    children,
  };
  if (label) own.label = label;
  // Only surface `text` separately when `description` already claimed the label
  // slot and the two genuinely differ — otherwise `value` just repeats `label`.
  const text = attrText(attrs.text);
  if (text && text !== own.label) own.value = text;
  const identifier = attrText(attrs.id) || attrText(attrs.key);
  if (identifier) own.identifier = identifier;

  // Scaffolding contributes nothing itself; hoist whatever survived beneath it.
  // A container that is *itself* clickable, labelled, or carrying something the
  // subtree beneath it does not know is a real node wearing a layout type: ArkUI
  // builds buttons out of `Stack`/`Row`, and puts `.id()` — the string an
  // `await-ui-element {identifier}` selects on — on plain `Column`s.
  if (LAYOUT_CONTAINERS.has(type) && !label && !own.clickable && !ownCarriesState(own)) {
    return children;
  }

  // A wrapper whose only child covers exactly the same rect is a duplicate
  // layer: collapse to whichever of the two carries the label.
  //
  // Only when the wrapper is genuinely a duplicate, though. ArkUI sets `.id()`
  // and the state flags on the OUTER component, so a `Toggle` wrapping one
  // full-bleed `Image` — or a `List` holding a single full-height row — is the
  // node that knows it is checked, disabled or scrollable, and the child that
  // fills its rect knows none of it. Collapsing those dropped the identifier an
  // agent selects on and every flag but `clickable`, which reported a disabled
  // button as a plain tappable one.
  if (own.children.length === 1 && own.pixelBounds && !ownCarriesState(own)) {
    const only = own.children[0];
    if (only.pixelBounds && rectsEqual(only.pixelBounds, own.pixelBounds) && !own.label) {
      return [{ ...only, clickable: only.clickable || own.clickable }];
    }
  }

  return [own];
}

/**
 * Whether a node knows something the subtree beneath it cannot: an identifier to
 * select on, or any state flag other than `clickable` (which the collapse
 * merges onto the surviving child, and which the hoist tests separately).
 *
 * `value` is deliberately absent: it is only ever set alongside a label, and
 * both callers already check for one.
 */
function ownCarriesState(n: HarmonyNode): boolean {
  return Boolean(
    n.identifier ||
    n.longClickable ||
    n.scrollable ||
    n.checkable ||
    n.checked ||
    n.disabled ||
    n.focused ||
    n.selected
  );
}

function blank(attrs: Record<string, string>, bounds: PixelRect | null): HarmonyNode {
  return {
    role: "Group",
    pixelBounds: bounds,
    clickable: isTrue(attrs, "clickable"),
    longClickable: isTrue(attrs, "longClickable"),
    scrollable: isScrollable(attrs),
    checkable: isTrue(attrs, "checkable"),
    checked: isTrue(attrs, "checked"),
    // `enabled` is present on every node, so a missing value means the dump
    // changed shape — treat that as enabled rather than reporting the whole
    // screen as greyed out.
    disabled: attrs.enabled === "false",
    focused: isTrue(attrs, "focused"),
    selected: isTrue(attrs, "selected"),
    children: [],
  };
}

/**
 * Map an ArkUI component type onto the role vocabulary the describe formatter
 * and the agent-facing guidance already use, so a HarmonyOS tree reads like an
 * iOS or Android one.
 */
function deriveRole(type: string, attrs: Record<string, string>): string {
  switch (type) {
    case "Text":
    case "Span":
    case "TextClock":
      return "StaticText";
    case "TextInput":
    case "TextArea":
    case "SearchField":
    case "Search":
      return "TextField";
    case "Image":
    case "SymbolGlyph":
      return "Image";
    case "Toggle":
      return attrs.checkable === "true" ? "Switch" : "Button";
    case "Checkbox":
      return "Checkbox";
    case "Slider":
      return "Slider";
    case "List":
    case "Grid":
    case "Scroll":
    case "WaterFlow":
      return "ScrollView";
    case "ListItem":
    case "GridItem":
      return "Cell";
    case "Swiper":
      return "Pager";
    case "Dialog":
      return "Dialog";
    case "Button":
      return "Button";
    default:
      // An unmapped type is still better information than a generic label: it
      // is the component the app author actually wrote.
      return type || "Group";
  }
}

/**
 * Whether a node lies entirely outside the screen and takes nothing with it.
 *
 * A `List` keeps its scrolled-off rows in the dump with real off-screen bounds,
 * and clipping those to the screen leaves a zero-area rect. Emitting it anyway
 * puts a `[clickable]` line in front of the agent whose documented tap centre
 * (`x + width/2`, `y + height/2`) is the status bar for a row above the fold and
 * the nav bar for one below it. The Android trimmer prunes the same rows, by its
 * own scroll-clip pass; harmony has no clip window to inherit, so the clipped
 * rect is the signal. A node with surviving children is kept regardless: it is
 * the child that would be lost, and a bounds-less parent's frame is their union.
 */
function isFullyOffScreen(frame: DescribeNode["frame"], children: DescribeNode[]): boolean {
  // Zero AREA, not zero in both axes: a row scrolled above the fold clips to the
  // full screen width and no height at all.
  return children.length === 0 && frame.width * frame.height === 0;
}

function toDescribeNode(n: HarmonyNode, screenW: number, screenH: number): DescribeNode {
  const children = n.children
    .map((c) => toDescribeNode(c, screenW, screenH))
    .filter((c) => !isFullyOffScreen(c.frame, c.children));
  const b = n.pixelBounds;
  const frame = b ? normalizeFrame(b, screenW, screenH) : unionFrame(children);
  const out: DescribeNode = { role: n.role, frame, children };
  if (n.label) out.label = n.label;
  if (n.identifier) out.identifier = n.identifier;
  if (n.value) out.value = n.value;
  if (n.clickable) out.clickable = true;
  if (n.longClickable) out.longClickable = true;
  if (n.scrollable) out.scrollable = true;
  if (n.checkable) out.checkable = true;
  if (n.checked) out.checked = true;
  if (n.disabled) out.disabled = true;
  if (n.focused) out.focused = true;
  if (n.selected) out.selected = true;
  return out;
}

/**
 * Clip a pixel rect to the screen, then normalise — the same discipline as the
 * Android and Vega adapters.
 *
 * ArkUI reports off-screen bounds for rows scrolled past the edge of a List, so
 * the order matters: normalising each component independently and clamping it
 * into [0,1] turns a row at `[0,-400][1216,-260]` into `y=0, height=0.052` — a
 * full-width tap target at the top of the screen, indistinguishable from the
 * genuinely visible row straddling that edge. Clipping first leaves an entirely
 * off-screen row with zero area, and keeps `x + width` inside the frame
 * contract for one only partly off-screen.
 */
function normalizeFrame(
  b: { x: number; y: number; w: number; h: number },
  screenW: number,
  screenH: number
): DescribeNode["frame"] {
  const clipped = clipBoundsToScreen(b, screenW, screenH);
  return {
    x: screenW > 0 ? clipped.x / screenW : 0,
    y: screenH > 0 ? clipped.y / screenH : 0,
    width: screenW > 0 ? clipped.w / screenW : 0,
    height: screenH > 0 ? clipped.h / screenH : 0,
  };
}

function unionFrame(children: DescribeNode[]): DescribeNode["frame"] {
  if (children.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.min(...children.map((c) => c.frame.x));
  const y1 = Math.min(...children.map((c) => c.frame.y));
  const x2 = Math.max(...children.map((c) => c.frame.x + c.frame.width));
  const y2 = Math.max(...children.map((c) => c.frame.y + c.frame.height));
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

interface HarmonyTreeResult {
  tree: DescribeNode;
  screen: { width: number; height: number };
}

/**
 * Build the describe tree.
 *
 * The screen size comes from the dump's own root bounds rather than a separate
 * device query: the two are read at different instants, and on a foldable that
 * is enough for a rotation between them to normalise every frame against the
 * wrong axis. `fallback` covers a root that reports no bounds.
 */
export function parseHarmonyLayout(
  root: HarmonyLayoutNode,
  fallback: { width: number; height: number }
): HarmonyTreeResult {
  const rootBounds = parseHarmonyBounds(root.attributes?.bounds ?? "");
  const screen =
    rootBounds && rootBounds.w > 0 && rootBounds.h > 0
      ? { width: rootBounds.w, height: rootBounds.h }
      : fallback;

  // Each top-level child is a window. Tag it with the app that owns it so a
  // tree spanning an app plus the status bar (always a separate `sceneboard`
  // window) is readable rather than two anonymous stacks. The bundle goes in
  // `identifier`, NOT `label`: the shared matcher treats `label` as the
  // element's visible text, and a full-screen node "named" `com.huawei.hmos.*`
  // is a phantom text node — it ties with the app's real title in reading
  // order (poisoning a `text` wait for the app's own name), and it makes
  // `exists: {text: "sceneboard"}` true on every screen.
  const windows: DescribeNode[] = [];
  for (const child of root.children ?? []) {
    const attrs = child.attributes ?? {};
    const bundle = attrText(attrs.bundleName);
    const built = build(child)
      .map((n) => toDescribeNode(n, screen.width, screen.height))
      .filter((n) => !isFullyOffScreen(n.frame, n.children));
    if (built.length === 0) continue;
    if (!bundle) {
      windows.push(...built);
      continue;
    }
    windows.push({
      role: "Window",
      identifier: bundle,
      frame: unionFrame(built),
      children: built,
    });
  }

  return {
    tree: {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: windows,
    },
    screen,
  };
}

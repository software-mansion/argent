import type { DescribeNode } from "../../contract";
import type { HarmonyLayoutNode } from "../../../../utils/harmony-uitest";
import { clipBoundsToScreen } from "../android/uiautomator-parser";

/**
 * `uitest dumpLayout` to the shared describe tree. Modelled on the Android
 * trimmer, but `uitest` already merges windows and drops hidden nodes, and a
 * `List` rect is not a clip rect (rows render under a collapsing title), so
 * there is no scroll clip. All attribute values are strings.
 */

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

/** Layout scaffolding, walked through rather than emitted. */
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

const DECORATIONS = new Set(["Divider", "ScrollBar", "metaballNode"]);

/** Renders out of process; usually dumped childless, sometimes with its subtree. */
const OPAQUE_EXTENSION = "UIExtensionComponent";

const SCROLL_TYPES = new Set(["List", "Grid", "Scroll", "Swiper", "WaterFlow"]);

function isScrollable(attrs: Record<string, string>): boolean {
  return SCROLL_TYPES.has(attrs.type ?? "") || isTrue(attrs, "scrollable");
}

/** Tolerates a non-string value rather than throwing out of `describe`. */
function attrText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `description` (accessibilityText) over `text`, as Android's `content-desc`; `hint` labels an empty field. */
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

  // Only a childless extension is opaque; one with a subtree is live UI.
  if (type === OPAQUE_EXTENSION && children.length === 0) {
    return [
      {
        ...blank(attrs, bounds),
        role: "SystemOverlay",
        // `identifier`, not `label`: see the window tag in parseHarmonyLayout.
        identifier: attrText(attrs.id) || attrText(attrs.key) || "ui-extension-overlay",
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
  const text = attrText(attrs.text);
  if (text && text !== own.label) own.value = text;
  const identifier = attrText(attrs.id) || attrText(attrs.key);
  if (identifier) own.identifier = identifier;

  // Hoist through scaffolding unless it carries its own label, tap or state:
  // ArkUI builds buttons from `Stack`/`Row` and puts `.id()` on plain `Column`s.
  if (LAYOUT_CONTAINERS.has(type) && !label && !own.clickable && !ownCarriesState(own)) {
    return children;
  }

  // Collapse a wrapper whose only child fills its rect, unless the wrapper holds
  // the id or state flags (ArkUI puts them on the outer component).
  if (own.children.length === 1 && own.pixelBounds && !ownCarriesState(own)) {
    const only = own.children[0];
    if (only.pixelBounds && rectsEqual(only.pixelBounds, own.pixelBounds) && !own.label) {
      // A mapped wrapper role wins (`ListItem` -> Cell over its layout child).
      return [
        {
          ...only,
          clickable: only.clickable || own.clickable,
          ...(MAPPED_ROLES.has(type) ? { role: own.role } : {}),
        },
      ];
    }
  }

  return [own];
}

/** An identifier or a state flag besides `clickable`, which a collapse merges. */
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
    // Missing means enabled.
    disabled: attrs.enabled === "false",
    focused: isTrue(attrs, "focused"),
    selected: isTrue(attrs, "selected"),
    children: [],
  };
}

/** Types deriveRole maps explicitly; anything else reports its raw type. */
const MAPPED_ROLES = new Set([
  "Text",
  "Span",
  "TextClock",
  "TextInput",
  "TextArea",
  "SearchField",
  "Search",
  "Image",
  "SymbolGlyph",
  "Toggle",
  "Checkbox",
  "Slider",
  "List",
  "Grid",
  "Scroll",
  "WaterFlow",
  "ListItem",
  "GridItem",
  "Swiper",
  "Dialog",
  "Button",
]);

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
      return type || "Group";
  }
}

/**
 * Off-screen `List` rows clip to zero area; emitting them would put tappable
 * lines centred on the status or nav bar. Kept if any child survives.
 */
function isFullyOffScreen(frame: DescribeNode["frame"], children: DescribeNode[]): boolean {
  // Area, not both axes: a row above the fold clips to full width, zero height.
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

/** Clip to the screen before normalising, or an off-screen row clamps onto the edge as a phantom target. */
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
 * Screen size comes from the dump's root bounds, read at the same instant as
 * the frames; `fallback` covers a root with none.
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

  // Each top-level child is a window, tagged with its owning bundle in
  // `identifier`: as a `label` it would match text searches on every screen.
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

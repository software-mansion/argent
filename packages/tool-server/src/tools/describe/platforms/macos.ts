import type { DeviceInfo, Registry } from "@argent/registry";
import type { MacosAppApi } from "../../../blueprints/macos-app";
import { resolveMacosApp } from "../../../utils/macos-input";
import {
  parseDescribeResult,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
  type DescribeTreeData,
} from "../contract";

/**
 * The `describe` adapter of a native Mac app, and the read the flow tree
 * (`flow-macos-tree.ts`) shares with it.
 *
 * The in-app library answers `Accessibility.getTree` (the app's accessibility
 * tree, plus `extraViews`: identified views that accessibility does not expose,
 * which is where React Native `Text` and `View` testIDs are) and `Web.tree` for
 * each web view in that tree.
 *
 * Frames arrive as fractions of the app window, title bar included, grown to
 * hold its sheets, popovers, the app-modal alert and open menus. They are not
 * clamped: an element of another window or one a scroll view has scrolled away
 * can lie outside 0-1, and the frames of scrolled away rows often still fall
 * inside it. So every frame is clipped by that area, its window and each
 * enclosing scroll area and web view, and what is left with no area is dropped.
 */

// Longer than the library's own limits, so its error, not ours, names the cause.
const TREE_CALL_TIMEOUT_MS = 22_000;
const WEB_TREE_CALL_TIMEOUT_MS = 12_000;

/**
 * Wait before the one re-read when a read met elements that did not answer.
 * Measured after a SwiftUI toggle click: 7 of 30 reads at 0 ms met such an
 * element, 0 of 30 at 150 ms.
 */
export const MACOS_UNREACHABLE_REREAD_MS = 150;

/** The limits a read sends: tree nodes, and items per web view. */
export interface MacosReadLimits {
  maxNodes: number;
  maxItems: number;
}

/** `describe` keeps the library's defaults, which bound what an agent reads. */
export const MACOS_DESCRIBE_LIMITS: MacosReadLimits = { maxNodes: 3000, maxItems: 3000 };

/** A read that judges the screen (a flow step, an await) needs every element, as on Android and Chromium. */
export const MACOS_JUDGING_LIMITS: MacosReadLimits = { maxNodes: 12_000, maxItems: 12_000 };

// A text area can hold a whole document, and every await poll ships the tree.
const MAX_TEXT_LENGTH = 1000;

/** Roles a pointer click acts on: flow leaves without a label, `[clickable]` in `describe`. */
const MACOS_CLICKABLE_ROLES: ReadonlySet<string> = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXMenuButton",
  "AXMenuItem",
  "AXMenuBarItem",
  "AXLink",
  "AXDisclosureTriangle",
  "AXTab",
  "AXRow",
  "AXCell",
  "AXColorWell",
  "AXIncrementor",
  "AXSlider",
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
  "AXSearchField",
]);

const CHECKABLE_ROLES: ReadonlySet<string> = new Set(["AXCheckBox", "AXRadioButton"]);

const UNFOCUSED_ROLES: ReadonlySet<string> = new Set(["AXWindow", "AXSheet", "AXRow", "AXCell"]);

// Never a flow leaf: a window would hoist every text of the screen onto one
// frame that covers it, and a scroll bar and its parts carry no target.
const NON_LEAF_ROLES: ReadonlySet<string> = new Set([
  "AXWindow",
  "AXSheet",
  "AXScrollBar",
  "AXValueIndicator",
]);

// Identifiers AppKit assigns on its own, measured on the fixture app: `_NS:87`
// (an alert sheet and its texts), a private action selector
// (`_popUpItemAction:`, on every item of a popup button's menu), and the table
// and outline view keys (`NSTableViewRowViewKey`, on every row view of an open
// menu). SwiftUI's: a window's scene id (`SwiftUI.WindowGroup<App.RootView>-1-AppWindow-1`)
// and the split view named after it (`..., SidebarNavigationSplitView`), and
// every List row and cell (`ListRow`, `ListCell`). They change between runs or
// are shared, so a selector recorded on one would not replay.
const APPKIT_IDENTIFIER =
  /^(_NS:|_[A-Za-z][A-Za-z0-9]*:$|NS(TableView|OutlineView)[A-Za-z]*Key$|List(Row|Cell)$)|-AppWindow-\d+(,|$)/;

function appIdentifier(v: unknown): string | undefined {
  const id = str(v);
  return id && !APPKIT_IDENTIFIER.test(id) ? id : undefined;
}

/** A rect in fractions of the reference window. Any finite value, not clamped. */
interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One item of a `Web.tree` result. */
interface WireWebItem {
  tag: string;
  id: string;
  testid: string;
  label: string;
  role: string;
  type: string;
  /** The element's visible text (80 characters). */
  text: string;
  /** The element's visible text, space-joined (1000 characters); the placeholder for a password. */
  fullText: string;
  /** The element's own direct visible text; "" for a form control. */
  ownText: string;
  /** A field's `placeholder` attribute. */
  placeholder: string;
  value: string | null;
  disabled: boolean;
  focused: boolean;
  checked: boolean;
  normalizedFrame?: NormRect;
}

/** The describe fields of a node; a flag is present only when true. */
type MacosFields = Pick<
  DescribeNode,
  | "role"
  | "label"
  | "value"
  | "identifier"
  | "clickable"
  | "scrollable"
  | "checkable"
  | "checked"
  | "disabled"
  | "focused"
  | "selected"
  | "password"
  | "layer"
>;

/** One element of the app, in the shape both trees project from. */
export interface MacosNode {
  d: MacosFields;
  /** The unclipped frame, or null when unknown. */
  rect: NormRect | null;
  /** `rect` clipped by the window and every enclosing scroll area and web view; null when nothing shows. */
  visible: DescribeFrame | null;
  /** Clips its subtree: a window, a scroll area, a web view. */
  clips: boolean;
  /** A scroll area or a web view: what it clips is scrolled out of view, not cut off. */
  scrolls: boolean;
  /** A web view: the items its page hides in an inner scroller or out of its viewport. */
  hiddenItems?: number;
  /** May become a flow leaf, and its text may hoist. False for windows and scroll bars. */
  leafEligible: boolean;
  /**
   * Set on the topmost content node of an out-of-view subtree: "scroll" when an
   * enclosing scroll area or web view hides it, "window" when it lies outside
   * the window. `describe` counts these.
   */
  offscreen?: "scroll" | "window";
  /** Children that the library did not read because a scroll area scrolled them out of view. */
  scrolledOutRows?: number;
  /**
   * The text the library collected below a web item or an identified view,
   * whose descendants are not nodes here. Never set on a password.
   */
  subtreeText?: string;
  /** The flow tree's hoisted text, set for the await tools' read only. */
  hoistedText?: string;
  children: MacosNode[];
}

/** One `Accessibility.getTree` result, with the `Web.tree` of each web view it met. */
export interface MacosTreeRead {
  bundleId: string;
  source: Extract<DescribeSource, "macos-devtools" | "macos-fallback">;
  /** The Mac was locked during a fallback read. */
  locked: boolean;
  truncated: boolean;
  unreachableCount: number;
  /** One message per web view whose `Web.tree` failed; its content is missing. */
  webErrors: string[];
  /** A web view's items were cut at `limits.maxItems`. */
  webTruncated: boolean;
  limits: MacosReadLimits;
  /** The app's elements, clipped: window roots, then open menus, then identified views. */
  nodes: MacosNode[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRect(v: unknown): NormRect | undefined {
  if (!isRecord(v)) return undefined;
  const [x, y, width, height] = [v.x, v.y, v.width, v.height].map(finite);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return width < 0 || height < 0 ? undefined : { x, y, width, height };
}

function asWebItem(v: unknown): WireWebItem | null {
  if (!isRecord(v)) return null;
  const s = (k: string): string => (typeof v[k] === "string" ? (v[k] as string) : "");
  return {
    tag: s("tag").toLowerCase(),
    id: s("id"),
    testid: s("testid"),
    label: s("label"),
    role: s("role").toLowerCase(),
    type: s("type").toLowerCase(),
    text: s("text"),
    fullText: s("fullText"),
    ownText: s("ownText"),
    placeholder: s("placeholder"),
    value: typeof v.value === "string" ? v.value : null,
    disabled: v.disabled === true,
    focused: v.focused === true,
    checked: v.checked === true,
    normalizedFrame: asRect(v.normalizedFrame),
  };
}

/**
 * A secure text field: the library's decision, the subrole AppKit gives it, or
 * the class of the view or its cell (NSSecureTextField, NSSecureTextFieldCell,
 * RCTUISecureTextField).
 */
function isSecure(r: Record<string, unknown>): boolean {
  if (r.secure === true || r.subrole === "AXSecureTextField") return true;
  const cls = typeof r.class === "string" ? r.class : r.viewClassName;
  return typeof cls === "string" && /SecureTextField/i.test(cls);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collected text: whitespace runs (the newlines between blocks) read as one space. */
function capText(text: string | undefined): string | undefined {
  return cap(text?.replace(/\s+/g, " ").trim());
}

function cap(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function newNode(d: MacosFields, rect: NormRect | undefined): MacosNode {
  for (const k of Object.keys(d) as Array<keyof MacosFields>) {
    if (!d[k]) delete (d as Partial<MacosFields>)[k];
  }
  return {
    d,
    rect: rect ?? null,
    visible: null,
    clips: false,
    scrolls: false,
    leafEligible: !NON_LEAF_ROLES.has(d.role),
    children: [],
  };
}

// Web roles in the AX vocabulary, so one `role:` selector works on native and
// web content alike. These are the roles WebKit itself reports for them.
const INTERACTIVE_ARIA_ROLES: Record<string, string> = {
  button: "AXButton",
  link: "AXLink",
  checkbox: "AXCheckBox",
  switch: "AXCheckBox",
  radio: "AXRadioButton",
  tab: "AXTab",
  textbox: "AXTextField",
  searchbox: "AXTextField",
  combobox: "AXComboBox",
  menuitem: "AXMenuItem",
  slider: "AXSlider",
};

const STRUCTURAL_ARIA_ROLES: Record<string, string> = {
  heading: "AXHeading",
  img: "AXImage",
  image: "AXImage",
  list: "AXList",
};

function webRole(item: WireWebItem): string {
  const aria = INTERACTIVE_ARIA_ROLES[item.role];
  if (aria) return aria;
  switch (item.tag) {
    case "button":
      return "AXButton";
    case "a":
      return "AXLink";
    case "textarea":
      return "AXTextArea";
    case "select":
      return "AXPopUpButton";
    case "img":
      return "AXImage";
    case "input":
      switch (item.type) {
        case "checkbox":
          return "AXCheckBox";
        case "radio":
          return "AXRadioButton";
        case "range":
          return "AXSlider";
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "AXButton";
        default:
          return "AXTextField";
      }
  }
  const structural = STRUCTURAL_ARIA_ROLES[item.role];
  if (structural) return structural;
  // Named text and nothing to operate: a text leaf, whatever its tag. A
  // container (its text is its children's) and an element with only an id are
  // groups, there to scope a selector.
  return contentName(item).trim() ? "AXStaticText" : "AXGroup";
}

// The elements a browser names from their content (the ARIA "name from content"
// rule of the accessible name computation): a button is called what it shows,
// even when the text sits in a child span. argent's Chromium walker does not do
// this; it names an element only from its attributes and its own text nodes.
const NAME_FROM_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "button",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "summary",
  "legend",
  "td",
  "th",
]);

const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "heading",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
  "cell",
  "columnheader",
  "rowheader",
  "tooltip",
]);

/**
 * The text that names a web item that is not a field (after its aria-label):
 * its visible text when it is named from its content, else its own direct
 * text. A container's visible text is every descendant's, and would let a
 * selector for a child's text match the container too.
 */
function contentName(item: WireWebItem): string {
  return NAME_FROM_CONTENT_TAGS.has(item.tag) || NAME_FROM_CONTENT_ROLES.has(item.role)
    ? item.text
    : item.ownText;
}

function webNode(item: WireWebItem): MacosNode {
  const role = webRole(item);
  const field = item.tag === "input" || item.tag === "textarea" || item.tag === "select";
  const password = field && item.type === "password";
  const node = newNode(
    {
      role,
      identifier: item.testid || item.id,
      // A field is named by its aria-label, else its placeholder, never by its
      // text: that is the value cut at 80 characters, the options of a select,
      // or for a password the secret.
      label: cap(field ? item.label || item.placeholder : item.label || contentName(item)),
      value: field && !password ? cap(item.value ?? undefined) : undefined,
      password,
      clickable: MACOS_CLICKABLE_ROLES.has(role),
      checkable: CHECKABLE_ROLES.has(role),
      checked: item.checked,
      disabled: item.disabled,
      // Set only while the web view has keyboard focus.
      focused: item.focused,
    },
    item.normalizedFrame
  );
  // A container's whole text, for a `text` check on it: its children are items
  // of their own, not its descendants here, so the flow tree cannot hoist it.
  if (!field) node.subtreeText = capText(item.fullText);
  return node;
}

/** Collects, while the tree is built, what is not a child of the node it hangs under. */
interface TreeBuild {
  /** The web view nodes per web view index, filled once their items are read. */
  webViews: Map<number, MacosNode[]>;
  /** Open menus, lifted to the top. */
  menus: MacosNode[];
}

// The `layer` of a root by its window kind (an alert over the sheets of the
// windows), one more in each sheet or popover attached over it (an alert over a
// sheet over the window), and MENU_LAYER in an open menu, which lies over everything.
const MENU_LAYER = 100;
const KIND_LAYERS = new Map([
  ["menu", MENU_LAYER],
  ["sheet", 1],
  ["alert", 2],
  ["popover", 1],
  ["file-panel", 1],
]);
const ATTACHED_ROLES = new Set(["AXSheet", "AXPopover"]);

function axNode(
  r: Record<string, unknown>,
  build: TreeBuild,
  layer: number,
  inScrollBar = false
): MacosNode | null {
  // An element that did not answer: its keys are partial and its children were not read.
  if (r.unreachable === true) return null;
  const role = str(r.role) ?? "AXUnknown";
  const secure = isSecure(r);
  const checkable = CHECKABLE_ROLES.has(role);
  const webView = finite(r.webView);
  if (role === "AXMenu") layer = MENU_LAYER;
  const node = newNode(
    {
      role,
      label: cap(str(r.title) ?? str(r.description) ?? str(r.placeholder)),
      identifier: appIdentifier(r.identifier),
      value: secure ? undefined : cap(str(r.value)),
      password: secure,
      clickable: MACOS_CLICKABLE_ROLES.has(role),
      scrollable: role === "AXScrollArea",
      checkable,
      checked: checkable && r.value === "1",
      disabled: r.enabled === false,
      // A focused window covers every target, so it would pass any focus check.
      // SwiftUI reports every List row and cell focused; a field in one reports its own focus.
      focused: r.focused === true && !UNFOCUSED_ROLES.has(role),
      selected: r.selected === true,
      layer,
    },
    asRect(r.normalizedFrame)
  );
  if (inScrollBar) node.leafEligible = false;
  node.scrolledOutRows = finite(r.scrolledOutRows);
  // A web page scrolls inside its web view, and its items keep their frames
  // when scrolled out of it.
  node.clips = node.scrolls = role === "AXScrollArea" || webView !== undefined;
  if (webView !== undefined) {
    build.webViews.set(webView, [...(build.webViews.get(webView) ?? []), node]);
    return node;
  }
  for (const child of Array.isArray(r.children) ? r.children : []) {
    const converted = isRecord(child)
      ? axNode(
          child,
          build,
          ATTACHED_ROLES.has(str(child.role) ?? "") ? layer + 1 : layer,
          inScrollBar || role === "AXScrollBar"
        )
      : null;
    // An open menu is a child of the button that opened it, and an open combo
    // box list a child of its combo box, but they float over the window: lifted
    // to the top, so no scroll area they sit in clips them.
    if (
      converted?.d.role === "AXMenu" ||
      (role === "AXComboBox" && converted?.d.role === "AXScrollArea")
    ) {
      build.menus.push(converted);
    } else if (converted) node.children.push(converted);
  }
  return node;
}

/** Identified views that accessibility does not expose, read as the static text they mostly are. */
function extraViewNode(v: Record<string, unknown>): MacosNode | null {
  const identifier = appIdentifier(v.identifier);
  // The part of the view its superviews and scroll views leave visible; the
  // library sends null, or a rect with no area, when nothing of it shows.
  const visible = asRect(v.visibleNormalizedFrame);
  if (!identifier || !visible) return null;
  const secure = isSecure(v);
  // A secure field's text is its value, the secret.
  const node = newNode(
    {
      role: secure ? "AXTextField" : "AXStaticText",
      identifier,
      password: secure,
      label: secure ? undefined : cap(str(v.text)),
    },
    visible
  );
  if (!secure) node.subtreeText = capText(str(v.subtreeText));
  return node;
}

const WINDOW_SQUARE: NormRect = { x: 0, y: 0, width: 1, height: 1 };

function intersect(a: NormRect, b: NormRect): NormRect {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

function hasArea(r: NormRect): boolean {
  return r.width > 0 && r.height > 0;
}

function isContent({ d }: MacosNode): boolean {
  return Boolean(d.identifier || d.label || d.value || d.clickable);
}

/**
 * Set `visible` on every node: its rect clipped by `clip`, the window square
 * intersected with the rects of the enclosing windows, scroll areas and web
 * views. `scrolled` says a scroll area or a web view encloses the node, and
 * `marked` that an ancestor already carries `offscreen`.
 */
function clipTree(node: MacosNode, clip: NormRect, scrolled: boolean, marked: boolean): void {
  // A sheet or a popover hangs over its window and can reach past it.
  if (node.d.role === "AXSheet" || node.d.role === "AXPopover") clip = WINDOW_SQUARE;
  if (node.rect) {
    const v = intersect(node.rect, clip);
    node.visible = hasArea(v) ? v : null;
    if (!node.visible && !marked && hasArea(node.rect) && isContent(node)) {
      if (scrolled) node.offscreen = "scroll";
      else if (!hasArea(intersect(node.rect, WINDOW_SQUARE))) node.offscreen = "window";
    }
  }
  const childClip = node.clips && node.rect ? intersect(node.rect, clip) : clip;
  for (const child of node.children) {
    clipTree(child, childClip, scrolled || node.scrolls, marked || node.offscreen !== undefined);
  }
}

async function getTree(
  api: MacosAppApi,
  limits: MacosReadLimits
): Promise<Record<string, unknown>> {
  const raw = await api.call<unknown>(
    "Accessibility.getTree",
    { maxNodes: limits.maxNodes },
    { timeoutMs: TREE_CALL_TIMEOUT_MS }
  );
  if (!isRecord(raw) || !Array.isArray(raw.windows)) {
    throw new Error("Accessibility.getTree returned no windows");
  }
  return raw;
}

/**
 * Read the app's tree: `Accessibility.getTree`, once more after
 * {@link MACOS_UNREACHABLE_REREAD_MS} when it met elements that did not answer,
 * then `Web.tree` for each web view in it. A failed first tree read rejects; a
 * failed web view read is recorded in `webErrors` and the caller decides.
 */
export async function readMacosTree(
  api: MacosAppApi,
  limits: MacosReadLimits = MACOS_DESCRIBE_LIMITS
): Promise<MacosTreeRead> {
  let raw = await getTree(api, limits);
  if ((finite(raw.unreachableCount) ?? 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, MACOS_UNREACHABLE_REREAD_MS));
    // The first read stands when the second one fails: it is complete but for
    // the elements that did not answer.
    raw = await getTree(api, limits).catch(() => raw);
  }

  const build: TreeBuild = { webViews: new Map(), menus: [] };
  const nodes: MacosNode[] = [];
  for (const entry of raw.windows as unknown[]) {
    if (!isRecord(entry) || !isRecord(entry.root)) continue;
    const root = axNode(entry.root, build, KIND_LAYERS.get(str(entry.kind) ?? "") ?? 0);
    if (!root) continue;
    // An open context menu comes as a root of kind "menu": it floats like an
    // open popup menu.
    if (entry.kind === "menu" || root.d.role === "AXMenu") {
      build.menus.push(root);
      continue;
    }
    // A sheet or a popover window clips like the main one.
    root.clips = true;
    root.leafEligible = false;
    nodes.push(root);
  }
  nodes.push(...build.menus);
  for (const v of Array.isArray(raw.extraViews) ? raw.extraViews : []) {
    const node = isRecord(v) ? extraViewNode(v) : null;
    if (node) nodes.push(node);
  }

  const webErrors: string[] = [];
  let webTruncated = false;
  for (const [index, webViews] of [...build.webViews].sort(([a], [b]) => a - b)) {
    try {
      const result = await api.call<{ items?: unknown; truncated?: unknown; hidden?: unknown }>(
        "Web.tree",
        { webView: index, maxItems: limits.maxItems },
        { timeoutMs: WEB_TREE_CALL_TIMEOUT_MS }
      );
      if (result?.truncated === true) webTruncated = true;
      const items = (Array.isArray(result?.items) ? result.items : [])
        .map(asWebItem)
        .filter((i): i is WireWebItem => i !== null);
      for (const node of webViews) {
        node.children = items.map(webNode);
        if (node.d.layer) for (const child of node.children) child.d.layer = node.d.layer;
        node.hiddenItems = finite(result?.hidden);
      }
    } catch (err) {
      webErrors.push(`web view ${index}: ${errMsg(err)}`);
    }
  }
  for (const root of nodes) clipTree(root, WINDOW_SQUARE, false, false);

  return {
    bundleId: api.bundleId,
    source: raw.source === "fallback" ? "macos-fallback" : "macos-devtools",
    locked: raw.locked === true,
    truncated: raw.truncated === true,
    unreachableCount: finite(raw.unreachableCount) ?? 0,
    webErrors,
    webTruncated,
    limits,
    nodes,
  };
}

function unionFrame(nodes: DescribeNode[]): DescribeFrame {
  let x1 = 1;
  let y1 = 1;
  let x2 = 0;
  let y2 = 0;
  for (const n of nodes) {
    x1 = Math.min(x1, n.frame.x);
    y1 = Math.min(y1, n.frame.y);
    x2 = Math.max(x2, n.frame.x + n.frame.width);
    y2 = Math.max(y2, n.frame.y + n.frame.height);
  }
  if (x2 <= x1 || y2 <= y1) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Project one node for `describe`. A node with nothing visible is dropped, and
 * its surviving children are promoted to the parent: a group the window cuts
 * can still hold an element inside it. `hidden` is the scroll-hidden count of
 * the nearest scroll area or web view; a scroller that is itself dropped
 * passes its count up.
 */
function toDescribe(
  n: MacosNode,
  outsideWindow: { count: number },
  hidden: { count: number }
): DescribeNode[] {
  if (n.offscreen === "scroll") hidden.count++;
  else if (n.offscreen === "window") outsideWindow.count++;
  const inner = n.scrolls ? { count: n.hiddenItems ?? 0 } : hidden;
  inner.count += n.scrolledOutRows ?? 0;
  const children = n.children.flatMap((c) => toDescribe(c, outsideWindow, inner));
  if (!n.visible && children.length === 0) {
    if (n.scrolls) hidden.count += inner.count;
    return [];
  }
  const out: DescribeNode = { ...n.d, frame: n.visible ?? unionFrame(children), children };
  if (n.hoistedText) out.subtreeText = n.hoistedText;
  if (n.scrolls && inner.count > 0) out.scrollHidden = inner.count;
  return [out];
}

/**
 * A fallback read, mostly while the Mac is locked: the tree can miss what a
 * custom control draws.
 */
export const MACOS_LOCKED_HINT =
  "The Mac is locked, so this tree can miss elements a custom control draws. Taps, typing " +
  "and screenshots still work.";
export const MACOS_FALLBACK_HINT =
  "The app's accessibility tree is not available, so this tree comes from a fallback walk " +
  "that can miss elements a custom control draws and an open context menu.";

/** `tree` with the read's source and the hints about what the read could not show. */
export function macosTreeData(
  read: MacosTreeRead,
  tree: DescribeNode,
  extraHints: string[] = []
): DescribeTreeData {
  const hints: string[] = [];
  if (read.source === "macos-fallback") {
    hints.push(read.locked ? MACOS_LOCKED_HINT : MACOS_FALLBACK_HINT);
  }
  if (read.truncated) {
    hints.push(
      `The tree was cut at the library's limit (${read.limits.maxNodes} elements or depth 40), ` +
        "so some elements are missing."
    );
  }
  if (read.webTruncated) {
    hints.push(
      `Web content was cut at the library's limit (${read.limits.maxItems} items per web view), ` +
        "so some of it is missing."
    );
  }
  if (read.unreachableCount > 0) {
    hints.push(
      `${read.unreachableCount} element(s) did not answer (a view in the middle of an update) and ` +
        "are missing; read again."
    );
  }
  if (read.webErrors.length > 0) {
    hints.push(`Web content could not be read (${read.webErrors.join("; ")}).`);
  }
  hints.push(...extraHints);
  const data: DescribeTreeData = { tree, source: read.source };
  if (hints.length > 0) data.hint = hints.join(" ");
  return data;
}

/**
 * Project a library read into the `describe` tree: nested, clipped, in 0-1.
 * `subtreeText` is set only where the await tools stamped the flow tree's
 * hoisted text (`describeMacosForJudging` in flow-macos-tree.ts).
 */
export function projectMacosDescribeTree(read: MacosTreeRead): DescribeTreeData {
  const outsideWindow = { count: 0 };
  const children = read.nodes.flatMap((root) => toDescribe(root, outsideWindow, { count: 0 }));
  const tree = parseDescribeResult({
    role: "AXApplication",
    label: read.bundleId,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
  return macosTreeData(
    read,
    tree,
    outsideWindow.count > 0
      ? [
          `${outsideWindow.count} element(s) lie outside the app window and were omitted: ` +
            "input reaches only the window and its sheets, alerts and menus.",
        ]
      : []
  );
}

/** `describe` on a Mac app. Refuses when the macos-apps flag is off. */
export async function describeMacos(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  return projectMacosDescribeTree(
    await readMacosTree(await resolveMacosApp(registry, device, "describe"))
  );
}

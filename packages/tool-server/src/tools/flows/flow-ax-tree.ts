import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";
import type { FlowTreeTarget } from "./flow-actions";
import { queryFullHierarchyTree } from "./flow-ios-tree";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../describe/contract";
import { adaptAxTree } from "../ui-tree/ios";
import type { UiTree, UiTreeNode } from "../ui-tree/index";
import {
  findAll,
  frameContains,
  nodeAtPoint,
  nodeText,
  selectorToFrame,
  treeFingerprint,
  type Selector,
} from "../../utils/ui-tree-match";
import { flattenHoisting, type FlatNode } from "./flow-tree-flatten";

/**
 * iOS simulator flow tree: the accessibility daemon's `tree`, the same source
 * `describe` reads, projected into the flow contract (flat leaves under one
 * root, hoisted `subtreeText`).
 *
 * Compared with the describe list, the flow tree keeps every node that carries
 * an identifier, a label, a value, keyboard focus or a content role — so a
 * container with only a testID (`feedItem-by-<handle>`, `card-3`) is a node a
 * `within` scope can name — and drops what a presentation covers (the daemon's
 * `covered` flag: the screen under a sheet, alert or popover is on screen but
 * not reachable). Off-screen nodes get no leaf, as the simulator projection
 * always did. No injection is involved: the daemon reads whatever is in front,
 * system apps and dialogs included.
 */

type UiOrientation = Parameters<typeof findAll>[2];

/** The accessibility node a flat leaf was projected from, for ancestry. */
const SOURCE_OF = new WeakMap<DescribeNode, UiTreeNode>();
/** Parent links over the (deduped) accessibility tree. */
const PARENT = new WeakMap<UiTreeNode, UiTreeNode>();
/** Leaves that are VoiceOver targets (`isAccessibleElement`), what a finger lands on. */
const TARGETS = new WeakSet<DescribeNode>();
/** Document order over the (deduped) accessibility tree: what is drawn later comes later. */
const ORDER = new WeakMap<UiTreeNode, number>();

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function round12(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}

/** Clamp a daemon frame to the screen; null when nothing of it is on screen. */
function normalizeFrame(f: DescribeFrame): DescribeFrame | null {
  const x1 = clamp01(f.x);
  const y1 = clamp01(f.y);
  const x2 = clamp01(f.x + f.width);
  const y2 = clamp01(f.y + f.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: round12(x1), y: round12(y1), width: round12(x2 - x1), height: round12(y2 - y1) };
}

const frameKey = (f: DescribeFrame | undefined): string =>
  f ? [f.x, f.y, f.width, f.height].map((v) => v.toFixed(4)).join("|") : "";

/**
 * The raw tree lists a labelled control and its own inner text as two nodes
 * with the same frame, label and value (a UIButton over its title label, an
 * RN Pressable over its Text). Merge such a child into its parent so a text
 * selector counts one element, and carry the identifier and focus up.
 */
function mergeIdenticalChildren(node: UiTreeNode): void {
  const kept: UiTreeNode[] = [];
  for (const child of node.children) {
    const same =
      frameKey(child.frame) === frameKey(node.frame) &&
      (child.label ?? "") === (node.label ?? "") &&
      (child.value ?? "") === (node.value ?? "") &&
      (!child.identifier || !node.identifier || child.identifier === node.identifier);
    if (same) {
      if (child.identifier && !node.identifier) node.identifier = child.identifier;
      if (child.focused) node.focused = true;
      if (child.accessible) node.accessible = true;
      if (child.role !== "AXGroup" && node.role === "AXGroup") node.role = child.role;
      kept.push(...child.children);
    } else {
      kept.push(child);
    }
  }
  node.children = kept;
  for (const child of node.children) {
    PARENT.set(child, node);
    mergeIdenticalChildren(child);
  }
}

let orderSeq = 0;
function stampOrder(node: UiTreeNode): void {
  ORDER.set(node, orderSeq++);
  for (const child of node.children) stampOrder(child);
}

function projectAxNode(node: UiTreeNode): FlatNode<UiTreeNode> {
  const skip = node.covered === true;
  const frame = node.frame ? normalizeFrame(node.frame) : null;
  const eligible =
    !skip &&
    Boolean(node.identifier || node.label || node.value || node.focused || node.role !== "AXGroup");
  let leaf: DescribeNode | null = null;
  if (eligible && frame) {
    leaf = { role: node.role, frame, children: [] };
    if (node.label) leaf.label = node.label;
    if (node.value) leaf.value = node.value;
    if (node.identifier) leaf.identifier = node.identifier;
    if (node.focused) leaf.focused = true;
    if (node.disabled) leaf.disabled = true;
    if (node.selected) leaf.selected = true;
    if (node.checked !== undefined) leaf.checked = node.checked;
    if (node.password) leaf.password = true;
    SOURCE_OF.set(leaf, node);
    if (node.accessible) TARGETS.add(leaf);
  }
  return {
    skip,
    children: node.children,
    // Text hoists only from on-screen nodes (see `flattenHoisting`).
    ownText: leaf ? nodeText(leaf) : "",
    leaf,
    shield: Boolean(node.identifier),
    // The daemon reports no scroll containers; scrolled-out content arrives
    // off screen and is dropped by the frame clamp above.
    rect: null,
    scrolls: false,
  };
}

/**
 * The daemon lists some views twice, under two containers: MapKit reports each
 * annotation view both as a map accessibility element and as a subview of its
 * annotation container, same frame, label and identifier. Two leaves that
 * agree on everything a selector can see are one element to a tap: keep the
 * copy drawn last, so the cover rule sees it over the map's own labels.
 */
function dedupeIdenticalLeaves(leaves: DescribeNode[]): DescribeNode[] {
  const key = (n: DescribeNode) =>
    [n.role, frameKey(n.frame), n.label ?? "", n.value ?? "", n.identifier ?? ""].join("\u0000");
  const order = (n: DescribeNode) => ORDER.get(SOURCE_OF.get(n)!) ?? -1;
  const keep = new Map<string, DescribeNode>();
  for (const n of leaves) {
    const k = key(n);
    const prev = keep.get(k);
    if (!prev || order(prev) < order(n)) keep.set(k, n);
  }
  return leaves.filter((n) => keep.get(key(n)) === n);
}

/** Read the daemon tree once and project it for the flow runner and recorder. */
export async function queryAxFlowTree(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
  const raw = await ax.tree();
  // A blind read must fail the step, never settle or satisfy `hidden`: the
  // daemon always reports at least the app element, so zero nodes means it
  // could not read the screen (a simulator booted outside argent, a wedged
  // service), not an empty screen.
  if (raw.nodes.length === 0) {
    throw new Error(
      `the accessibility daemon returned no elements for ${device.id}` +
        (ax.degraded
          ? " (the simulator was not booted through argent, so its reads can be blind)"
          : "") +
        `; flows resolve selectors against its tree, so the step fails rather than treating the screen as empty`
    );
  }
  return projectUiTreeForFlows(adaptAxTree(raw));
}

/** Project an adapted daemon tree into the flow contract. Pure, for tests and offline checks. */
function projectUiTreeForFlows(ui: UiTree): DescribeTreeData {
  const children: DescribeNode[] = [];
  for (const root of ui.roots) {
    // The roots are the app elements themselves and are never emitted; their
    // children are the screen. Merging starts below the root so a full-screen
    // container is never absorbed into it.
    for (const child of root.children) {
      PARENT.set(child, root);
      mergeIdenticalChildren(child);
      stampOrder(child);
      flattenHoisting(child, projectAxNode, children);
    }
  }
  // Not `parseDescribeResult`: its zod parse clones every leaf, which would
  // orphan the SOURCE_OF links the recorder's ancestry walk depends on. The
  // leaves are built well-formed above.
  const tree: DescribeNode = {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: dedupeIdenticalLeaves(children),
  };
  return {
    tree,
    source: "ax-service",
    ...(ui.screen ? { screen: ui.screen } : {}),
    ...(ui.truncated
      ? {
          hint: "the accessibility tree was cut at the daemon's node or depth cap; nodes may be missing",
        }
      : {}),
  };
}

/**
 * After a failed daemon read, how long reads go straight to the fallback
 * before the daemon is tried again. A wedged daemon answers only by timeout
 * (10 s), which a flow of thirty reads must not pay thirty times; a daemon that
 * recovers is picked up at the next window.
 */
const AX_RETRY_AFTER_MS = 60_000;
/** Per registry (so tests stay isolated), per device: the last daemon failure and when to retry. */
const AX_DOWN = new WeakMap<Registry, Map<string, { until: number; reason: string }>>();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remember that the daemon failed for this device, so the next reads skip straight to the fallback for a while. */
function markAxUnavailable(registry: Registry, device: DeviceInfo, reason: string): void {
  let perDevice = AX_DOWN.get(registry);
  if (!perDevice) AX_DOWN.set(registry, (perDevice = new Map()));
  perDevice.set(device.id, { until: Date.now() + AX_RETRY_AFTER_MS, reason });
}

function axDownReason(registry: Registry, device: DeviceInfo): string | undefined {
  const down = AX_DOWN.get(registry)?.get(device.id);
  return down && down.until > Date.now() ? down.reason : undefined;
}

/**
 * Null when the accessibility daemon reads this simulator, else why not (and
 * the failure is remembered, see {@link markAxUnavailable}). One real read,
 * not a bare resolve: a daemon build without `tree`, or one that answers
 * blind, resolves fine and fails only when asked. The launch gate asks this
 * first: a daemon that reads needs no injection, so the launch is ready;
 * otherwise the gate waits for the fallback's native-devtools connection.
 */
export async function axServiceUnavailableReason(
  registry: Registry,
  device: DeviceInfo
): Promise<string | null> {
  const known = axDownReason(registry, device);
  if (known) return known;
  try {
    await queryAxFlowTree(registry, device);
    return null;
  } catch (err) {
    const reason = errMsg(err);
    markAxUnavailable(registry, device, reason);
    return reason;
  }
}

/**
 * The iOS simulator flow tree: the daemon's `tree` first; when the daemon
 * cannot read (unavailable, a build without `tree`, a timeout, a blind read),
 * the UIView hierarchy over native-devtools, the source flows read before.
 * The fallback result carries the daemon's reason in its hint, and its own
 * `source` ("native-devtools"), so the recorder and the run report say which
 * tree a step used. The fallback lists views by class, has no id-only
 * containers and needs the injected dylib, so selectors derived from it can
 * differ from the daemon's.
 */
export async function queryIosSimulatorFlowTree(
  registry: Registry,
  device: DeviceInfo,
  target?: FlowTreeTarget
): Promise<DescribeTreeData> {
  let reason = axDownReason(registry, device);
  if (!reason) {
    try {
      return await queryAxFlowTree(registry, device);
    } catch (err) {
      reason = errMsg(err);
      markAxUnavailable(registry, device, reason);
    }
  }
  let fallback: DescribeTreeData;
  try {
    fallback = await queryFullHierarchyTree(registry, device, target);
  } catch (err) {
    throw new Error(
      `the accessibility daemon could not read ${device.id} (${reason}), and the UIView hierarchy ` +
        `fallback failed too: ${errMsg(err)}`,
      { cause: err }
    );
  }
  const note =
    `the accessibility daemon could not read the screen (${reason}); this read used the UIView ` +
    `hierarchy over native-devtools, which lists views by class and has no id-only containers`;
  return { ...fallback, hint: fallback.hint ? `${fallback.hint}; ${note}` : note };
}

/** Read until two consecutive reads agree, within a short budget, so a mid-animation read does not derive a selector. */
export async function readSettledIosFlowTree(
  registry: Registry,
  device: DeviceInfo,
  budgetMs = 1500
): Promise<DescribeTreeData> {
  const deadline = Date.now() + budgetMs;
  let last = await queryIosSimulatorFlowTree(registry, device);
  // A read slower than the budget cannot settle within it, and a screen that
  // slow to read (a stalled SwiftUI transition, a long web page) only gets
  // slower under a second read: take the one read.
  if (Date.now() >= deadline) return last;
  let fp = treeFingerprint(last.tree);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const next = await queryIosSimulatorFlowTree(registry, device);
    const nfp = treeFingerprint(next.tree);
    last = next;
    if (nfp === fp) break;
    fp = nfp;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Recorder: a selector for the element under a tap, scoped when needed.

const positional = (id: string): boolean => /(^|[-_.])\d+$/.test(id);
const dataLike = (id: string): boolean => id.length > 40 || /[@:/]/.test(id);
const visibleArea = (n: DescribeNode): boolean => n.frame.width > 0 && n.frame.height > 0;
/** The share of `a`'s area that lies inside `b`. */
const overlapOf = (a: DescribeFrame, b: DescribeFrame): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const area = a.width * a.height;
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
};
const readingOrder = (a: DescribeNode, b: DescribeNode): number =>
  Math.abs(a.frame.y - b.frame.y) > 0.012 ? a.frame.y - b.frame.y : a.frame.x - b.frame.x;
const equalsCI = (a: string | undefined, b: string): boolean =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/**
 * Matches counted the way replay ranks them: a `text` must match exactly
 * (case-insensitive), not as a substring, so "Save" is not ambiguous because
 * of "Save changes". Ids and relations use the runner's own matcher.
 */
function exactMatches(
  flat: DescribeNode,
  sel: Selector,
  orientation?: UiOrientation
): DescribeNode[] {
  const all = findAll(flat, sel, orientation);
  if (sel.text === undefined) return all;
  return all.filter((n) => equalsCI(n.label, sel.text!) || equalsCI(n.value, sel.text!));
}

function isAncestor(a: UiTreeNode, b: UiTreeNode): boolean {
  for (let p = PARENT.get(b); p; p = PARENT.get(p)) if (p === a) return true;
  return false;
}
function depth(n: UiTreeNode): number {
  let d = 0;
  for (let p = PARENT.get(n); p; p = PARENT.get(p)) d++;
  return d;
}

/**
 * A list row that reads its parts as one label ("Berlin, Germany" over a
 * title and a subtitle): the parts are its children's own labels, and such a
 * label follows the content ("Berlin, Recently Viewed · Germany" on the next
 * visit).
 */
function aggregateLabel(leaf: DescribeNode): boolean {
  const src = SOURCE_OF.get(leaf);
  const label = leaf.label ?? "";
  if (!src || !label.includes(", ")) return false;
  const parts = src.children.map((c) => (c.label ?? "").trim()).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => label.includes(p));
}

/** The title part of a combined row label: the child label the row label starts with. */
function titlePart(leaf: DescribeNode): string | undefined {
  const src = SOURCE_OF.get(leaf);
  const label = (leaf.label ?? "").trim();
  if (!src || !aggregateLabel(leaf)) return undefined;
  return src.children
    .map((c) => (c.label ?? "").trim())
    .find((p) => p && p.length < label.length && label.toLowerCase().startsWith(p.toLowerCase()));
}

function ancestorsWithId(leaf: DescribeNode): UiTreeNode[] {
  const out: UiTreeNode[] = [];
  for (let a = PARENT.get(SOURCE_OF.get(leaf)!); a; a = PARENT.get(a))
    if (a.identifier) out.push(a);
  // Stable ids first: non-positional and non-data-like, then nearest.
  return out.sort(
    (a, b) =>
      Number(positional(a.identifier!)) - Number(positional(b.identifier!)) ||
      Number(dataLike(a.identifier!)) - Number(dataLike(b.identifier!))
  );
}
function nearestIdAncestor(leaf: DescribeNode): UiTreeNode | undefined {
  for (let a = PARENT.get(SOURCE_OF.get(leaf)!); a; a = PARENT.get(a)) if (a.identifier) return a;
  return undefined;
}

const CONTROL_ROLES = new Set(["AXButton", "AXLink", "AXTextField", "AXAdjustable", "AXTabBar"]);

/**
 * The element a user touches, among the VoiceOver targets under the point.
 *
 * A target drawn over another hides it: a later target in document order that
 * is neither an ancestor nor a descendant of an earlier one (a sheet's Done
 * over the toolbar button under the sheet, search results over the list they
 * cover) wins outright, whatever the covered one carries. The daemon flags
 * covered content for alerts, but not for a sheet or a search overlay. Two
 * exceptions: a later non-control target that holds most of the earlier one
 * (two thirds of its area or more) with room to spare is background, not a
 * cover (a card heading listed after the small Close button that sits on it,
 * even where the button pokes out of the heading by a few points; a control
 * never is: a later card's wide close button over the narrow Close of the
 * card beneath covers it); and a plain text decorates what it is drawn on
 * rather than covering it (the count on a map cluster marker, listed after
 * the marker as a sibling).
 *
 * What remains is a chain of nested targets. One with a handle (an id or a
 * text) first, then a control over a plain text or group (a UIButton over its
 * own title label, which the tree also lists). Between two controls the inner
 * one: the clear button inside a text field, the like button on a tappable
 * card. Otherwise one with an id, then the smallest. Without any target, the
 * smallest node with content.
 */
function targetAt(flat: DescribeNode, point: { x: number; y: number }): DescribeNode | undefined {
  const src = (n: DescribeNode) => SOURCE_OF.get(n)!;
  const order = (n: DescribeNode) => ORDER.get(src(n)) ?? -1;
  const area = (n: DescribeNode) => n.frame.width * n.frame.height;
  const control = (n: DescribeNode) => CONTROL_ROLES.has(n.role);
  const handle = (n: DescribeNode) => Boolean(n.identifier || (n.label ?? n.value ?? "").trim());
  const rank = (n: DescribeNode) => (handle(n) ? 0 : 1) * 2 + (control(n) ? 0 : 1);
  const under = flat.children.filter(
    (n) => TARGETS.has(n) && visibleArea(n) && frameContains(n.frame, point.x, point.y)
  );
  const related = (a: DescribeNode, b: DescribeNode) =>
    isAncestor(src(a), src(b)) || isAncestor(src(b), src(a));
  const background = (b: DescribeNode, a: DescribeNode) =>
    !control(b) && overlapOf(a.frame, b.frame) >= 2 / 3 && area(b) > 1.5 * area(a);
  const plainText = (n: DescribeNode) => n.role === "AXStaticText" && !n.identifier;
  const covers = (b: DescribeNode, a: DescribeNode) =>
    order(b) > order(a) && !related(a, b) && !background(b, a) && !plainText(b);
  const top = under.filter((a) => !under.some((b) => covers(b, a)));
  top.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (control(a) && control(b)
        ? depth(src(b)) - depth(src(a))
        : (a.identifier ? 0 : 1) - (b.identifier ? 0 : 1)) ||
      area(a) - area(b)
  );
  return top[0] ?? nodeAtPoint(flat, point);
}

interface DerivedSelector {
  selector: Selector;
  strategy: "id" | "text" | "within" | "next" | "after";
  /** The id or anchor that made the selector unique. */
  scope?: string;
  /** The tap point inside the resolved element, as fractions of its frame, when it is not near the centre; `x`/`y` beside `on` in YAML. */
  offset?: { x: number; y: number };
  /** Stability notes: positional or data-like ids in the selector or its scope. */
  notes?: string;
}

/**
 * Derive a selector that resolves to the element under `point` and to nothing
 * else: its id; else its text; scoped by the nearest stable ancestor id
 * (`within`), else by a unique preceding anchor (`next`/`after`). Every
 * candidate must match exactly one visible node AND that node must contain
 * the tap point, so a selector can never silently elect a different element.
 */
export function deriveScopedSelector(
  flat: DescribeNode,
  point: { x: number; y: number },
  orientation?: UiOrientation
): DerivedSelector | { warning: string } {
  const node = targetAt(flat, point);
  if (!node) return { warning: "no element found under the tap; kept coordinates (brittle)" };
  const own = (node.label ?? node.value ?? "").trim();
  const textSel: Selector | null = own ? { text: own, role: node.role } : null;
  const title = titlePart(node);
  const idSel: Selector | null = node.identifier ? { identifier: node.identifier } : null;
  const unique = (s: Selector) => exactMatches(flat, s, orientation).length === 1;
  const covers = (s: Selector) => {
    const f = selectorToFrame(flat, s, orientation);
    return f !== undefined && frameContains(f, point.x, point.y);
  };
  const ok = (s: Selector) => unique(s) && covers(s);
  const finish = (
    selector: Selector,
    strategy: DerivedSelector["strategy"],
    scope?: string
  ): DerivedSelector => {
    const out: DerivedSelector = { selector, strategy, ...(scope ? { scope } : {}) };
    const f = selectorToFrame(flat, selector, orientation)!;
    const fx = (point.x - f.x) / f.width;
    const fy = (point.y - f.y) / f.height;
    if (Math.abs(fx - 0.5) > 0.15 || Math.abs(fy - 0.5) > 0.15) {
      out.offset = {
        x: Math.round(clamp01(fx) * 100) / 100,
        y: Math.round(clamp01(fy) * 100) / 100,
      };
    }
    const notes: string[] = [];
    const scopeId =
      selector.within?.identifier ?? selector.next?.identifier ?? selector.after?.identifier;
    if (selector.identifier && positional(selector.identifier))
      notes.push("the id looks positional");
    if (selector.identifier && dataLike(selector.identifier)) notes.push("the id looks like data");
    if (scopeId && positional(scopeId)) notes.push("the scope id looks positional");
    if (scopeId && dataLike(scopeId))
      notes.push("the scope id looks like data and may change with content");
    if (selector.text !== undefined && title && selector.text === title)
      notes.push(
        "the row's label joins its parts and can change with content; the selector uses its title part, matched as a substring"
      );
    else if (selector.text !== undefined && aggregateLabel(node))
      notes.push(
        "the text is a row's combined label and can change with content; an id inside the row is steadier"
      );
    if (notes.length) out.notes = notes.join("; ");
    return out;
  };
  const stableAncestors = () =>
    ancestorsWithId(node).filter((a) => !positional(a.identifier!) && !dataLike(a.identifier!));

  // 1. A stable own id, alone or inside a stable ancestor.
  if (idSel && !positional(node.identifier!)) {
    if (ok(idSel)) return finish(idSel, "id");
    for (const a of stableAncestors()) {
      const s: Selector = { ...idSel, within: { identifier: a.identifier } };
      if (ok(s)) return finish(s, "within", a.identifier);
    }
  }
  // 2. Text, alone or inside a stable ancestor (also the escape from a numbered own id).
  // A row whose label joins its parts ("Wawel Royal Castle, Wawel 5, Kraków"
  // over a title and an address) follows the content: it gains "Recently
  // Viewed" on the next visit. Its title part, matched as a substring, holds.
  if (title) {
    const s: Selector = { text: title, role: node.role };
    if (findAll(flat, s, orientation).length === 1 && covers(s)) return finish(s, "text");
  }
  if (textSel) {
    if (ok(textSel)) return finish(textSel, "text");
    for (const a of stableAncestors()) {
      const s: Selector = { ...textSel, within: { identifier: a.identifier } };
      if (ok(s)) return finish(s, "within", a.identifier);
    }
  }
  // 3. A numbered or data-like own id, the last unique single-field form.
  if (idSel && ok(idSel)) return finish(idSel, "id");
  const base = idSel ?? textSel;
  if (!base) return { warning: "tapped element has no stable text/id; kept coordinates (brittle)" };
  // 4. Inside any remaining ancestor with an id.
  for (const a of ancestorsWithId(node)) {
    const s: Selector = { ...base, within: { identifier: a.identifier } };
    if (ok(s)) return finish(s, "within", a.identifier);
  }
  // 5. A unique anchor before the target in reading order: the target's own
  //    container first, short ids before data-like ones, then the nearest.
  const order = flat.children.filter(visibleArea).sort(readingOrder);
  const ni = order.indexOf(node);
  const home = nearestIdAncestor(node);
  const cands: { s: Selector; dist: number; sameHome: number; ugly: number }[] = [];
  for (let i = ni - 1; i >= 0 && i >= ni - 12; i--) {
    const m = order[i];
    const text = m.label ?? m.value;
    const s: Selector | null = m.identifier ? { identifier: m.identifier } : text ? { text } : null;
    if (!s || !unique(s)) continue;
    cands.push({
      s,
      dist: ni - i,
      sameHome: home && nearestIdAncestor(m) === home ? 0 : 1,
      ugly: s.identifier && dataLike(s.identifier) ? 1 : 0,
    });
  }
  cands.sort((a, b) => a.sameHome - b.sameHome || a.ugly - b.ugly || a.dist - b.dist);
  for (const c of cands) {
    for (const key of ["next", "after"] as const) {
      const s: Selector = { ...base, [key]: c.s };
      if (ok(s)) return finish(s, key, c.s.identifier ?? JSON.stringify(c.s));
    }
  }
  const n = exactMatches(flat, base, orientation).length;
  return {
    warning: `selector for the tapped element matches ${n} elements and no scope makes it unique; kept coordinates (brittle)`,
  };
}

/**
 * A fallback for an element without id and without text, such as an icon
 * button: its role inside the nearest stable ancestor, when that is unique.
 * Weak, so the recorder says so. Called only when `deriveScopedSelector`
 * kept coordinates for lack of a stable text or id.
 */
export function deriveRoleInScope(
  flat: DescribeNode,
  point: { x: number; y: number },
  orientation?: UiOrientation
): DerivedSelector | undefined {
  const node = targetAt(flat, point);
  if (!node || node.identifier || (node.label ?? node.value ?? "").trim()) return undefined;
  const unique = (s: Selector) => findAll(flat, s, orientation).length === 1;
  const covers = (s: Selector) => {
    const f = selectorToFrame(flat, s, orientation);
    return f !== undefined && frameContains(f, point.x, point.y);
  };
  for (const a of ancestorsWithId(node)) {
    if (positional(a.identifier!) || dataLike(a.identifier!)) continue;
    const s: Selector = { role: node.role, within: { identifier: a.identifier } };
    if (unique(s) && covers(s)) {
      return {
        selector: s,
        strategy: "within",
        scope: a.identifier,
        notes: `the element has no id and no text, so the selector is its role inside ${a.identifier}; re-record against a labelled element if that is not reliably this one`,
      };
    }
  }
  return undefined;
}

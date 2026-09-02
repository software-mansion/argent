import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient text rendering of an already-pruned DescribeNode tree: the
// per-platform adapters (and the Android v2 trimmer in uiautomator-parser) do
// the pruning, this layer only formats.
//
// Render mode comes from `source`, not the tree silhouette — a single
// accidental grandchild used to flip an ax-service response into nested mode,
// which broke callers diffing two close-in-time describes.

const CONTENT_ROLES = new Set([
  // The roles mapNativeTraitsToDescribeRole can return. AXGroup is excluded on
  // purpose: as its catch-all fallback, requiring it to carry its own
  // label/value before we emit a line keeps decorative groupings out.
  "AXButton",
  "AXStaticText",
  "AXImage",
  "AXLink",
  "AXTextField",
  "AXHeading",
  "AXTabBar",
  "AXAdjustable",
  // Android: an `android.webkit.WebView` landmark. Chromium publishes the web
  // DOM as this node's children, and the page <title> on the root web area it
  // adds under an app's own WebView view — but it publishes neither while the
  // renderer is still starting. The app's view then stands alone, and on the
  // builds the checked-in captures come from it carries no label, no id and no
  // gesture flag, so `hasContent` is false and the renderer drops the one
  // element covering the screen. Listing the role keeps the landmark — and its
  // bounds — visible exactly as an icon-only AXButton stays visible.
  "WebView",
]);

// Vega UIToolkit roles: the toolkit emits these as undecorated leaves, which
// the nested renderer's content gate would otherwise drop. Kept separate from
// CONTENT_ROLES because the same lowercase roles occur on Chromium (an SVG
// `<text>`/`<image>`, `role="image"`), where counting them as content would
// print lines that are pruned today.
const VEGA_CONTENT_ROLES = new Set([...CONTENT_ROLES, "button", "text", "image"]);

function clampFinite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function fmtFrame(f: DescribeFrame): string {
  return `(${clampFinite(f.x).toFixed(3)}, ${clampFinite(f.y).toFixed(3)}, ${clampFinite(
    f.width
  ).toFixed(3)}, ${clampFinite(f.height).toFixed(3)})`;
}

function escapeForLine(s: string): string {
  // Escape rather than strip: a raw newline/tab breaks the one-line-per-node
  // shape callers grep, and escaping keeps the original character recoverable.
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function formatLabel(label: string | undefined): string {
  if (!label) return "";
  return `"${escapeForLine(label)}"`;
}

function formatAttr(name: string, value: string | undefined): string {
  if (!value) return "";
  return ` ${name}="${escapeForLine(value)}"`;
}

function formatFlags(n: DescribeNode): string {
  const flags: string[] = [];
  if (n.clickable) flags.push("clickable");
  if (n.longClickable) flags.push("long-clickable");
  if (n.scrollable) flags.push("scrollable");
  if (n.checkable) flags.push(n.checked ? "checked" : "checkable");
  if (n.focused) flags.push("focused");
  if (n.selected) flags.push("selected");
  if (n.disabled) flags.push("disabled");
  if (n.password) flags.push("password");
  if (typeof n.scrollHidden === "number" && n.scrollHidden > 0) {
    flags.push(`scrollHidden=${n.scrollHidden}`);
  }
  return flags.length === 0 ? "" : ` [${flags.join(",")}]`;
}

function hasContent(n: DescribeNode): boolean {
  return Boolean(
    n.label ||
    n.value ||
    n.identifier ||
    n.clickable ||
    n.longClickable ||
    n.scrollable ||
    n.checkable ||
    (typeof n.scrollHidden === "number" && n.scrollHidden > 0)
  );
}

// The role check is what keeps unlabeled `AXImage`s and icon-only `AXButton`s
// in the output — without it, anything missing `accessibilityLabel` on iOS
// would silently vanish from describe.
function shouldEmit(n: DescribeNode, contentRoles: ReadonlySet<string>): boolean {
  return hasContent(n) || contentRoles.has(n.role);
}

function formatLine(n: DescribeNode, indent: number): string {
  const pad = "  ".repeat(indent);
  // iOS reports a text input's placeholder as both label and value; printing
  // it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n);
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function renderFlat(root: DescribeNode, contentRoles: ReadonlySet<string>): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1));
}

function renderNested(root: DescribeNode, contentRoles: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees can't overflow the stack.
  // Start at depth 1: the header already prints the root as its ROOT line.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (shouldEmit(node, contentRoles) || node.children.length > 0) {
      lines.push(formatLine(node, depth));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

// A rendered tree is the whole payload of a describe result, and `main`'s
// auto-capture appends one after every interaction tool — so an unbounded
// rendering is charged again on each tap, swipe and keystroke. Most screens are
// well inside this: the busiest live Android capture measured 59 lines, a Chrome
// tab 21. A web page is what can run away — an Android WebView over a 12-column,
// 40-row table renders 392 lines, and the shape grows with the page.
const MAX_BODY_LINES = 500;

// How much of the budget is held back for the END of the walk. Keeping only the
// head is what a web page can exploit: its DOM fills the front of the walk and
// the host app's own controls sit behind it, so a capped Android WebView screen
// arrived with no browser toolbar and no app action bar — measured on an
// emulator, an in-app WebView over a 3,000-cell grid dropped every element the
// agent needed to leave the page. The lines that go are now a slice out of the
// middle instead.
const TAIL_BODY_LINES = 100;

// The second budget, because a line carries no bound of its own: `formatLine`
// passes a node's whole label and value through, and describe now reads a web
// page's text runs verbatim. A page that grows in TEXT rather than in node
// count went through the line budget untouched — measured on an emulator, 300
// long paragraphs rendered 59 lines and 64,000 characters, more than twice what
// a capped 510-line grid costs. 80 characters a line at the line budget, over
// the 60 a dense live Android capture averages, so an ordinary screen is still
// bound by lines and only a text-heavy one meets this.
const MAX_BODY_CHARS = 40_000;
const TAIL_BODY_CHARS = 8_000;

/**
 * How many lines from one end fit both budgets. Counts the newline the join
 * adds back, so the number is what the payload actually costs.
 */
function runWithin(body: string[], maxLines: number, maxChars: number, fromEnd: boolean): number {
  let chars = 0;
  let count = 0;
  while (count < body.length && count < maxLines) {
    const line = fromEnd ? body[body.length - 1 - count]! : body[count]!;
    if (chars + line.length + 1 > maxChars) break;
    chars += line.length + 1;
    count += 1;
  }
  return count;
}

// Cut the rendering at the budget and say what is missing, rather than hand
// back a tree that reads complete.
function capBody(body: string[]): string[] {
  const tail = runWithin(body, TAIL_BODY_LINES, TAIL_BODY_CHARS, true);
  // At least one line, so a single node whose text alone fills the budget still
  // shows the agent an element rather than a notice on its own.
  const head = Math.max(
    Math.min(body.length, 1),
    runWithin(body, MAX_BODY_LINES - TAIL_BODY_LINES, MAX_BODY_CHARS - TAIL_BODY_CHARS, false)
  );
  if (head + tail >= body.length) return body;
  const dropped = body.length - head - tail;
  return [
    ...body.slice(0, head),
    "",
    `... ${dropped} more elements are NOT shown. The rendering stops at ${MAX_BODY_LINES} lines ` +
      `or ${MAX_BODY_CHARS} characters, whichever comes first: it keeps the first ${head} lines ` +
      `and the last ${tail} of the walk and drops what is between them. Scroll the missing part ` +
      "into view and describe again. An element in the gap is still addressable: await-ui-element " +
      "and the flow selector directives match against the whole tree, not this rendering.",
    "",
    ...body.slice(body.length - tail),
  ];
}

export interface FormatDescribeOptions {
  source: DescribeSource;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: "flat" | "nested" =
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "cdp-dom" ||
    opts.source === "vega-automation"
      ? "nested"
      : "flat";
  const isVega = opts.source === "vega-automation";
  const header: string[] = [];
  header.push(`Source: ${opts.source}`);
  header.push(`Mode: ${mode}`);
  header.push(
    "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels."
  );
  if (isVega) {
    header.push(
      "Vega is remote-driven, not touch — there is no tap. Use the frames as spatial hints to plan " +
        "D-pad moves with the `tv-remote` tool: compare the target's frame to the cursor's — the " +
        "`[focused]` element, or `[selected]` when no element reports `[focused]` (the toolkit often " +
        "marks the highlighted item `selected` while `focused` stays false) — " +
        'and count rows/columns to build the path (e.g. one row down and two columns right → ["down","right","right","select"]).'
    );
  } else {
    header.push(
      "Pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space."
    );
    header.push(
      "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2."
    );
  }
  header.push("");
  header.push(`ROOT  ${root.role} ${fmtFrame(root.frame)}`);
  header.push("");

  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  const body = capBody(
    mode === "flat" ? renderFlat(root, contentRoles) : renderNested(root, contentRoles)
  );
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}

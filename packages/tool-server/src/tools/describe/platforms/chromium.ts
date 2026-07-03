import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { DescribeNode, DescribeTreeData } from "../contract";

// `unknown` across the whole family: the failures here stem from uncontrolled
// renderer output (eval threw, no value, unparseable payload), which we can't
// validate. `validation` stays reserved for schemas we own.
const DESCRIBE_FAILURE = {
  error_code: FAILURE_CODES.CHROMIUM_DESCRIBE_FAILED,
  failure_area: "tool_server",
  error_kind: "unknown",
} as const;

/**
 * In-page script that returns a JSON UI tree mirroring `DescribeNode`. We
 * collect ARIA role / accessible name, interactivity flags, and bounding
 * rects normalized to fractions of window.innerWidth/innerHeight (matching
 * the iOS/Android describe contract, so the same frame-centre tap math
 * applies on Chromium).
 *
 * Choices:
 *  - Walk children plus open shadow roots and same-origin iframe documents so
 *    modern Chromium apps (VS Code, Slack, custom-element-heavy SPAs) don't
 *    appear as empty pages.
 *  - Skip purely structural wrappers (anonymous single-child divs) so the
 *    tree stays small.
 *  - Treat anchors, buttons, inputs, [role=button], [onclick], [tabindex]≥0
 *    as `clickable: true` so the agent knows which nodes to tap.
 *  - Prune a node only when it is truly invisible (display:none, opacity:0) or its
 *    border box is zero-area AND it clips overflow. A zero-area box with the default
 *    overflow:visible still paints its descendants — so we traverse it and promote them
 *    instead of cutting the subtree. This covers display:contents wrappers (React Native
 *    Web nests content under them), the zero-height anchor of an absolutely-positioned
 *    dropdown/popover/portal, and float/overflow wrappers that collapse to a zero-height
 *    box. A collapsed overflow:hidden container genuinely hides its content, so it stays
 *    pruned. visibility:hidden is NOT hard-pruned (it inherits, but a descendant can
 *    override it back to visible): we descend and suppress only the hidden element's own
 *    paint, so a visibility:visible descendant still surfaces.
 *  - Cap node count at 5000 — that, not depth, bounds the payload a runaway SPA
 *    would otherwise serialize past CDP's single Runtime.evaluate reply limit
 *    (~50MB). Cap depth at 60 purely to bound recursion: modern React DOMs
 *    (React Native Web, navigator/provider stacks) routinely nest 25+ levels
 *    before reaching leaf text, so a shallower cap silently clips real content.
 *    Callers with a bigger appetite (the flow tree keeps more than the
 *    agent-facing describe, like Android's FLOW_MAX_NODES) can raise both via
 *    `limits`.
 */
export interface ChromiumWalkLimits {
  maxDepth: number;
  maxNodes: number;
}

const DEFAULT_WALK_LIMITS: ChromiumWalkLimits = { maxDepth: 60, maxNodes: 5000 };

// Interpolated into the in-page script: force a plain positive integer literal
// so no caller can ever smuggle text (or a cap-disabling NaN) into the
// renderer. Non-finite input falls back to the default.
function intForScript(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

const buildDescribeDomScript = ({ maxDepth, maxNodes }: ChromiumWalkLimits) => `(() => {
  const MAX_DEPTH = ${intForScript(maxDepth, DEFAULT_WALK_LIMITS.maxDepth)};
  const MAX_NODES = ${intForScript(maxNodes, DEFAULT_WALK_LIMITS.maxNodes)};
  let nodeBudget = MAX_NODES;
  let truncated = false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return JSON.stringify({ tree: null, error: "viewport is zero" });

  // Native prototype accessors, captured once. HTMLFormElement (and HTMLObject/Embed)
  // is [LegacyOverrideBuiltins]: a control named the same as an inherited member shadows
  // it on the <form>, so el.children returns the control element (not iterable) and
  // el.getAttribute returns an element (not a function) — both throw and abort the whole
  // walk, the exact crash class this walker must avoid. A prototype accessor is never
  // shadowed by a form's named properties, so EVERY inherited member read on a possibly-
  // clobbered element (methods and getters alike) goes through these via .call(el).
  //
  // protoGetter reads the accessor's getter defensively: if the descriptor is ever
  // absent (a page can delete/redefine a DOM prototype member), it falls back to a
  // direct property read so one missing accessor degrades a single node instead of a
  // \`.get\` on \`undefined\` throwing at script top and aborting the entire describe.
  function protoGetter(proto, prop) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    return d && d.get ? d.get : function () { return this[prop]; };
  }
  const getChildNodes = protoGetter(Node.prototype, "childNodes");
  const getNodeType = protoGetter(Node.prototype, "nodeType");
  const getNodeValue = protoGetter(Node.prototype, "nodeValue");
  const getTextContent = protoGetter(Node.prototype, "textContent");
  const getTagName = protoGetter(Element.prototype, "tagName");
  const getChildrenEls = protoGetter(Element.prototype, "children");
  const getShadowRoot = protoGetter(Element.prototype, "shadowRoot");
  const getScrollHeight = protoGetter(Element.prototype, "scrollHeight");
  const getClientHeight = protoGetter(Element.prototype, "clientHeight");
  const getScrollWidth = protoGetter(Element.prototype, "scrollWidth");
  const getClientWidth = protoGetter(Element.prototype, "clientWidth");
  const getAttr = Element.prototype.getAttribute;
  const hasAttr = Element.prototype.hasAttribute;
  const getBCR = Element.prototype.getBoundingClientRect;

  function nodeRole(el) {
    const r = getAttr.call(el, "role");
    if (r) return r;
    const t = getTagName.call(el).toLowerCase();
    return t;
  }

  function accessibleName(el) {
    const aria = getAttr.call(el, "aria-label");
    if (aria) return aria.trim().slice(0, 200);
    const labelledBy = getAttr.call(el, "aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = [];
      for (const id of ids) {
        const ref = document.getElementById(id);
        // getTextContent via the prototype: an aria-labelledby target can be a <form>
        // with a control named "textContent", which would shadow the inherited getter
        // to a control element and crash (.trim() on a non-string).
        if (ref) parts.push((getTextContent.call(ref) || "").trim());
      }
      if (parts.length) return parts.join(" ").slice(0, 200);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.slice(0, 200);
      if (el.value) return el.value.slice(0, 200);
    }
    if (el instanceof HTMLImageElement && el.alt) return el.alt.slice(0, 200);
    // getAttribute, not el.title: a <form> with a control named "title" clobbers the
    // .title property to return that element (not a string), and .slice() then throws,
    // aborting the whole describe. getAttribute always yields string | null.
    const t = getAttr.call(el, "title");
    if (t) return t.slice(0, 200);
    return null;
  }

  function ownText(el) {
    let s = "";
    for (const child of getChildNodes.call(el)) {
      // nodeType/nodeValue via the prototype getters, keeping the "every inherited
      // read goes through a captured getter" invariant whole: a child can be a
      // clobbering <form> whose named control shadows these to a control element.
      // (=== 3 already made a clobbered nodeType safe; this removes the lone
      // directly-read member so no read's safety rests on the comparison semantics.)
      if (getNodeType.call(child) === 3) s += getNodeValue.call(child);
    }
    return s.replace(/\\s+/g, " ").trim();
  }

  function isInteractive(el) {
    const tag = getTagName.call(el).toLowerCase();
    if (tag === "a" && el.href) return true;
    if (tag === "button") return true;
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (tag === "summary" || tag === "details") return true;
    if (hasAttr.call(el, "onclick")) return true;
    const role = getAttr.call(el, "role");
    if (role && /^(button|link|tab|menuitem|checkbox|radio|switch|option)$/i.test(role)) return true;
    const tabIndex = getAttr.call(el, "tabindex");
    if (tabIndex !== null && tabIndex !== "-1") return true;
    return false;
  }

  function isDisabled(el) {
    if (hasAttr.call(el, "disabled")) return true;
    if (getAttr.call(el, "aria-disabled") === "true") return true;
    return false;
  }

  function isChecked(el) {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      return el.checked;
    }
    const v = getAttr.call(el, "aria-checked");
    if (v === "true") return true;
    return false;
  }

  function isPassword(el) {
    return el instanceof HTMLInputElement && el.type === "password";
  }

  function isScrollable(el, style) {
    const oy = style.overflowY;
    const ox = style.overflowX;
    if (oy === "auto" || oy === "scroll" || ox === "auto" || ox === "scroll") {
      if (
        getScrollHeight.call(el) > getClientHeight.call(el) ||
        getScrollWidth.call(el) > getClientWidth.call(el)
      )
        return true;
    }
    return false;
  }

  function normRect(r) {
    const x = Math.max(0, Math.min(1, r.left / w));
    const y = Math.max(0, Math.min(1, r.top / h));
    const right = Math.max(0, Math.min(1, r.right / w));
    const bottom = Math.max(0, Math.min(1, r.bottom / h));
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  function frame(el) {
    return normRect(getBCR.call(el));
  }

  // Painted extent of an element's own inline TEXT. A box-less element (display:contents,
  // or a zero-width box whose text overflows) has a 0x0 border box yet its text still
  // paints; a Range over its own text measures that. Measure ONLY the element's direct
  // text-node children — NOT selectNodeContents(el) over the whole subtree, which also
  // spans the still-laid-out boxes of visibility:hidden / opacity:0 element descendants
  // (they keep a layout box but paint nothing), oversizing the frame and mis-placing the
  // tap point. Returns 0x0 when an ancestor transform (e.g. scale(0)) or display:none
  // collapses the paint. walk() consults this only when the element has its own text.
  function contentFrame(el) {
    try {
      let box = null;
      for (const child of getChildNodes.call(el)) {
        // nodeType via the prototype getter (clobber-safe, like ownText); own text only.
        if (getNodeType.call(child) !== 3) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (!box) {
          box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        } else {
          if (r.left < box.left) box.left = r.left;
          if (r.top < box.top) box.top = r.top;
          if (r.right > box.right) box.right = r.right;
          if (r.bottom > box.bottom) box.bottom = r.bottom;
        }
      }
      if (!box || box.right <= box.left || box.bottom <= box.top) return null;
      return normRect(box);
    } catch (e) {
      return null;
    }
  }

  function overflowClips(style) {
    return style.overflowX !== "visible" || style.overflowY !== "visible";
  }

  // An element has no box of its own when it is display:contents (renders children
  // but generates no box) or its border box is zero-area. We give such elements a
  // frame spanning their children rather than their own 0x0 rect.
  function boxless(el, style) {
    if (style.display === "contents") return true;
    const r = getBCR.call(el);
    return r.width <= 0 || r.height <= 0;
  }

  function hidden(el, style) {
    if (style.display === "none") return true;
    // display:contents has no box, so box-only properties don't apply — it lays
    // its children out normally. Never prune it for opacity:0 (opacity affects a
    // box, of which there is none, so descendants still paint) or for its 0x0
    // rect; walk() descends and promotes the visible content.
    if (style.display === "contents") return false;
    if (style.opacity === "0") return true;
    // visibility:hidden is deliberately NOT hard-pruned here: visibility inherits but a
    // descendant can override it back to visible, so cutting the subtree would drop
    // painted content. walk() descends and suppresses only this element's own paint
    // (see \`invisibleSelf\`), pruning it only if no visible descendant survives.
    const r = getBCR.call(el);
    if (r.width > 0 && r.height > 0) return false;
    // Zero-area box: prune it only when it clips its overflow (a collapsed
    // overflow:hidden container genuinely hides its content). With the default
    // overflow:visible, abs-positioned / overflowing / floated descendants still
    // paint, so walk() must descend and promote them instead of cutting the subtree.
    return overflowClips(style);
  }

  // Smallest normalized box covering every surviving child frame — the frame we give
  // a box-less wrapper we still emit, since it has no rect of its own.
  function unionFrame(children) {
    let minX = 1;
    let minY = 1;
    let maxRight = 0;
    let maxBottom = 0;
    for (const c of children) {
      minX = Math.min(minX, c.frame.x);
      minY = Math.min(minY, c.frame.y);
      maxRight = Math.max(maxRight, c.frame.x + c.frame.width);
      maxBottom = Math.max(maxBottom, c.frame.y + c.frame.height);
    }
    if (maxRight <= minX || maxBottom <= minY) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return { x: minX, y: minY, width: maxRight - minX, height: maxBottom - minY };
  }

  function walk(el, depth) {
    if (truncated) return null;
    if (depth > MAX_DEPTH) return null;
    if (!(el instanceof Element)) return null;
    const style = window.getComputedStyle(el);
    if (hidden(el, style)) return null;
    // Charge the node budget only for elements that can actually EMIT. A
    // visibility:hidden element paints nothing itself and is descended into
    // purely to catch a descendant that overrides visibility back to visible
    // (see hidden()); it is otherwise promoted/dropped. Counting it would let a
    // large fully-hidden subtree (a closed drawer/modal) exhaust the budget and
    // truncate genuinely visible content elsewhere in the tree. Its visible
    // descendants, if any, still consume the budget themselves.
    if (style.visibility !== "hidden") {
      if (nodeBudget <= 0) {
        truncated = true;
        return null;
      }
      nodeBudget--;
    }

    const childResults = [];
    for (const child of getChildrenEls.call(el)) {
      const c = walk(child, depth + 1);
      if (c) childResults.push(c);
    }

    // Pierce open shadow roots — closed roots are unreachable by design.
    // Web-components-heavy apps (VS Code, every Lit/Polymer SPA) put their
    // interactive content under .shadowRoot, so without this descent describe
    // returns an empty body.
    // getShadowRoot via the prototype: a <form> with a control named "shadowRoot"
    // would otherwise return that control, and we'd re-walk its light-DOM children as
    // shadow content and duplicate the subtree. A real ShadowRoot is a DocumentFragment
    // (never a form), so its own .children read is safe.
    const shadow = getShadowRoot.call(el);
    if (shadow) {
      for (const child of shadow.children) {
        const c = walk(child, depth + 1);
        if (c) childResults.push(c);
      }
    }

    // Same-origin iframes: pierce contentDocument if accessible. Cross-origin
    // contentDocument access throws SecurityError — swallowed silently so the
    // walker doesn't abort the whole tree.
    if (getTagName.call(el) === "IFRAME") {
      try {
        const doc = el.contentDocument;
        if (doc && doc.documentElement) {
          const c = walk(doc.documentElement, depth + 1);
          if (c) childResults.push(c);
        }
      } catch (e) {
        /* cross-origin iframe — skip */
      }
    }

    // A visibility:hidden element paints nothing itself, but a descendant can override
    // visibility back to visible, so walk() descended instead of pruning (see hidden()).
    // Suppress this element's own paint — its text / name / interactivity are invisible —
    // and treat it as box-less so it contributes no box of its own: it survives only
    // through, and is framed by, whatever visible descendants it has.
    const invisibleSelf = style.visibility === "hidden";
    const text = invisibleSelf ? "" : ownText(el);
    const name = invisibleSelf ? null : accessibleName(el);
    const clickable = invisibleSelf ? false : isInteractive(el);
    const role = nodeRole(el);
    // getAttribute, not el.id: like .title, a named form control can clobber the .id
    // property to a DOM node, which would then break JSON.stringify of the tree.
    // Computed here (before promotion) because an id / data-testid is agent-visible
    // targeting info: a wrapper that carries one is not a pure layer, so neither
    // promotion path below may drop it.
    const id =
      getAttr.call(el, "id") ||
      getAttr.call(el, "data-testid") ||
      getAttr.call(el, "data-test-id");
    const bl = invisibleSelf || boxless(el, style);

    // A box-less element has no rect of its own. Its visible extent is whatever its
    // children span; with no surviving child, fall back to the painted extent of its own
    // inline TEXT — but only when it has its own text. A Range over a wrapper whose
    // element children were all pruned as invisible still measures their
    // visibility:hidden / opacity:0 layout boxes (non-zero though nothing paints), which
    // would resurrect an empty wrapper with a real frame; own text is the only inline
    // content not already represented by childResults. If the frame is still zero-area it
    // paints nothing — e.g. a transform: scale(0) subtree, whose descendants all collapse
    // — so it is invisible and dropped. A box-less wrapper with one child and nothing of
    // its own (no clickable / name / text / identifier) is just a layer, so promote the
    // child. (Clickable / named / identified box-less nodes fall through and are emitted
    // with this child- or content-spanning frame.)
    let selfFrame;
    if (bl) {
      selfFrame = unionFrame(childResults);
      if (text && selfFrame.width <= 0 && selfFrame.height <= 0) {
        const cf = contentFrame(el);
        if (cf) selfFrame = cf;
      }
      if (childResults.length === 0 && selfFrame.width <= 0 && selfFrame.height <= 0) {
        return null;
      }
      if (
        !clickable &&
        !name &&
        !text &&
        !id &&
        childResults.length === 1 &&
        (role === "div" || invisibleSelf)
      ) {
        // Only a pure layout wrapper (a plain div, e.g. a display:contents RNW
        // wrapper) or a visibility:hidden element with no meaningful paint of
        // its own is promoted away. A box-less element with a SEMANTIC role
        // (list, nav, section, listitem, ...) is kept so its role isn't lost —
        // mirroring the role === "div" gate on the boxed structural collapse
        // below.
        return childResults[0];
      }
    } else {
      selfFrame = frame(el);
    }

    const scrollable = isScrollable(el, style);
    // Prune structural wrappers with no info that just add a layer. Keep them
    // if they're roots/clickable/named/identified/have text — or scroll their
    // content: an RN-web ScrollView renders as exactly this shape (a scroller
    // div wrapping a single content-container div), and pruning it would drop
    // the node scroll gestures and flow 'within' selectors anchor to.
    if (
      depth > 0 &&
      childResults.length === 1 &&
      !clickable &&
      !name &&
      !text &&
      !id &&
      !scrollable &&
      role === "div"
    ) {
      return childResults[0];
    }
    const node = {
      role,
      frame: selfFrame,
      children: childResults,
    };
    if (name) node.label = name;
    if (text && text !== name) node.value = text.slice(0, 200);
    if (id) node.identifier = id;
    if (clickable) node.clickable = true;
    if (isDisabled(el)) node.disabled = true;
    if (isChecked(el)) node.checked = true;
    if (isPassword(el)) node.password = true;
    if (scrollable) node.scrollable = true;
    return node;
  }

  const root = walk(document.documentElement, 0) || {
    role: "html",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };
  return JSON.stringify({ tree: root, truncated });
})()`;

// The default-limits build, exported for test/describe-chromium-script.test.ts,
// which evals it against a mock DOM to lock in the visibility/pruning rules (the
// script runs in the renderer, so the rest of the suite can only mock its CDP
// response).
export const DESCRIBE_DOM_SCRIPT = buildDescribeDomScript(DEFAULT_WALK_LIMITS);

export async function describeChromium(
  api: ChromiumCdpApi,
  limits: ChromiumWalkLimits = DEFAULT_WALK_LIMITS
): Promise<DescribeTreeData> {
  // Make sure the cached viewport is fresh — the script normalizes frames by
  // the live window dimensions, so any rescroll between calls is reflected.
  await api.refreshViewport();
  const raw = (await api.cdp.send("Runtime.evaluate", {
    expression: buildDescribeDomScript(limits),
    returnByValue: true,
  })) as {
    result?: { value?: string };
    exceptionDetails?: { text?: string };
  };
  if (raw.exceptionDetails) {
    throw new FailureError(
      `Chromium describe failed: ${raw.exceptionDetails.text ?? "renderer evaluation threw"}`,
      { ...DESCRIBE_FAILURE, failure_stage: "chromium_describe_eval" }
    );
  }
  const payload = raw.result?.value;
  if (typeof payload !== "string") {
    throw new FailureError("Chromium describe: renderer returned no value", {
      ...DESCRIBE_FAILURE,
      failure_stage: "chromium_describe_no_value",
    });
  }
  let parsed: { tree?: DescribeNode | null; truncated?: boolean; error?: string };
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new FailureError(
      `Chromium describe: could not parse renderer payload: ${err instanceof Error ? err.message : String(err)}`,
      { ...DESCRIBE_FAILURE, failure_stage: "chromium_describe_parse" },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (parsed.error) {
    throw new FailureError(`Chromium describe: ${parsed.error}`, {
      ...DESCRIBE_FAILURE,
      failure_stage: "chromium_describe_renderer_error",
    });
  }
  if (!parsed.tree) {
    throw new FailureError("Chromium describe: empty tree", {
      ...DESCRIBE_FAILURE,
      failure_stage: "chromium_describe_empty",
    });
  }
  const data: DescribeTreeData = { tree: parsed.tree, source: "cdp-dom" };
  if (parsed.truncated) {
    // Surface a server-side warning so a partial tree is visible to ops.
    process.stderr.write(
      `[chromium-describe] tree truncated at MAX_NODES — page exceeds the walker's budget; consider scoping the inspection.\n`
    );
    // And tell the agent via the existing `hint` channel (iOS/Vega already use it) so a
    // partial tree isn't silently consumed as if it were the whole page — no need to
    // widen the shared contract just for Chromium.
    data.hint =
      "describe hit the node budget (MAX_NODES) and returned a PARTIAL tree — some on-screen content is missing. Scope the inspection to a smaller region (scroll to or focus the relevant view) and describe again.";
  }
  return data;
}

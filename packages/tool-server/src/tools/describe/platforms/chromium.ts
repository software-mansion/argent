import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { DescribeNode, DescribeTreeData } from "../contract";

// `unknown`, not `validation`: these failures come from uncontrolled renderer
// output, not from a schema we own.
const DESCRIBE_FAILURE = {
  error_code: FAILURE_CODES.CHROMIUM_DESCRIBE_FAILED,
  failure_area: "tool_server",
  error_kind: "unknown",
} as const;

/**
 * Caps on the in-page walk. `maxNodes` bounds the payload a runaway SPA would
 * otherwise serialize past CDP's single Runtime.evaluate reply; `maxDepth` only
 * bounds recursion — React DOMs (React Native Web, navigator/provider stacks)
 * routinely nest 25+ levels before leaf text, so a shallower cap silently clips
 * real content. Flow callers keep more of the tree and raise both.
 */
export interface ChromiumWalkLimits {
  maxDepth: number;
  maxNodes: number;
}

const DEFAULT_WALK_LIMITS: ChromiumWalkLimits = { maxDepth: 60, maxNodes: 5000 };

// Interpolated into the in-page script, so it must come out a plain positive
// integer literal: no caller can smuggle in text or a cap-disabling NaN.
function intForScript(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

// In-page script returning a JSON tree shaped like `DescribeNode`, with frames
// normalized to fractions of window.innerWidth/innerHeight — the same contract as
// iOS/Android, so the frame-centre tap math is shared.
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
  const getAssignedSlot = protoGetter(Element.prototype, "assignedSlot");
  const getParentNode = protoGetter(Node.prototype, "parentNode");
  const getScrollHeight = protoGetter(Element.prototype, "scrollHeight");
  const getClientHeight = protoGetter(Element.prototype, "clientHeight");
  const getScrollWidth = protoGetter(Element.prototype, "scrollWidth");
  const getClientWidth = protoGetter(Element.prototype, "clientWidth");
  const getClientLeft = protoGetter(Element.prototype, "clientLeft");
  const getClientTop = protoGetter(Element.prototype, "clientTop");
  const getOffsetWidth = protoGetter(HTMLElement.prototype, "offsetWidth");
  const getOffsetHeight = protoGetter(HTMLElement.prototype, "offsetHeight");
  const getAttr = Element.prototype.getAttribute;
  const hasAttr = Element.prototype.hasAttribute;
  const getBCR = Element.prototype.getBoundingClientRect;
  const matchesSel = Element.prototype.matches;
  // Document's named getter is [LegacyOverrideBuiltIns] (like a form's): a
  // <form name="activeElement"> shadows document.activeElement, so both focus
  // reads go through prototype accessors. The typeof guard covers the test
  // harness's mock DOM, which defines no Document constructor — protoGetter's
  // direct-read fallback then degrades focus reporting instead of throwing.
  const docProto = typeof Document === "undefined" ? {} : Document.prototype;
  const getOwnerDocument = protoGetter(Node.prototype, "ownerDocument");
  const getActiveElement = protoGetter(docProto, "activeElement");
  const getDocBody = protoGetter(docProto, "body");
  const getRootNode = Node.prototype.getRootNode;
  const containsNode = Node.prototype.contains;
  const docElementsFromPoint = docProto.elementsFromPoint;
  // A document's named getter can shadow elementsFromPoint; a shadow root has none.
  function elementsAt(root, x, y) {
    return docElementsFromPoint && getNodeType.call(root) === 9
      ? docElementsFromPoint.call(root, x, y)
      : root.elementsFromPoint(x, y);
  }

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
      // Never fall through to a password input's value: with no aria label or
      // placeholder (a floating/uncontrolled-label pattern) the typed secret
      // would become the node's label and reach every describe consumer.
      if (el.value && !isPassword(el)) return el.value.slice(0, 200);
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

  // Clip windows are viewport-px rects; null means only the viewport, which normRect
  // already clamps to.
  function intersect(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
  }

  function frame(el, clip) {
    return normRect(intersect(getBCR.call(el), clip));
  }

  // Overflow clips a descendant only when the clipper is on its containing-block chain,
  // so an absolute or fixed box takes the clip in force at its containing block. Each
  // entry is the clip a child with that position gets.
  const NO_CLIP = { flow: null, abs: null, fixed: null };

  // A slotted element paints where its <slot> sits in the shadow tree, so it takes the
  // clips in force there; each host's shadow tree is walked before its light children.
  // globalThis: a page's top-level \`class Map\` shadows the bare name, not the property.
  const slotClips = new globalThis.Map();
  // Elements hidden() pruned: a slot inside one paints nothing.
  const pruned = new globalThis.Set();
  function inPruned(node) {
    for (let n = node; n; n = getParentNode.call(n)) if (pruned.has(n)) return true;
    return false;
  }

  // Each walked element's scrollers, its own last when it scrolls; the elements a
  // scroller cuts are anchored once the whole tree has been walked.
  const chains = new globalThis.Map();
  const cuts = [];

  // The scroller a wheel at (x, y) scrolls along an axis: the innermost on the
  // painted element's chain, the one Chrome latches to. Null where that is unknown:
  // over a frame, whose own document may take the wheel.
  function wheelScroller(x, y, axis) {
    let hit = elementsAt(document, x, y)[0];
    for (let sr = hit && getShadowRoot.call(hit); sr; sr = getShadowRoot.call(hit)) {
      const deeper = sr.elementsFromPoint(x, y)[0];
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    if (hit && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(htmlTag(hit))) return null;
    for (let n = hit; n; ) {
      if (chains.has(n)) {
        const chain = chains.get(n) || [];
        for (let i = chain.length - 1; i >= 0; i--) if (chain[i][axis]) return chain[i].el;
        return null;
      }
      const p = getAssignedSlot.call(n) || getParentNode.call(n);
      n = p && getNodeType.call(p) === 11 ? p.host : p;
    }
    return null;
  }

  // A point where a wheel scrolls the element (visible part r) against a scroller
  // cutting it along the axis: one on its chain from the outermost cutter in, of
  // scrollers \`scs\`. Elsewhere the wheel may move an overlay's scroller, the element's
  // own, or one holding the cutter. The innermost cutter's window is tried first, its
  // points farthest along the axis first: content scrolling under the point mid-wheel
  // takes the rest of it. With no such point on screen, the centre of the cut window
  // \`win\` across the element.
  function wheelAnchor(r, scs, cutters, win, axis) {
    const movers = scs.slice(scs.indexOf(cutters[0])).filter((s) => s[axis]);
    const away = ([x, y]) =>
      axis === "sx" ? Math.max(r.left - x, x - r.right) : Math.max(r.top - y, y - r.bottom);
    const points = [];
    for (let i = cutters.length - 1; i >= 0; i--) {
      const v = intersect(cutters[i].win, { left: 0, top: 0, right: w, bottom: h });
      const grid = [];
      for (const f of [0.1, 0.5, 0.9]) {
        for (const g of [0.1, 0.5, 0.9]) {
          grid.push([v.left + (v.right - v.left) * f, v.top + (v.bottom - v.top) * g]);
        }
      }
      points.push(...grid.sort((a, b) => away(b) - away(a)));
    }
    points.push([(r.left + r.right) / 2, (r.top + r.bottom) / 2]);
    for (const [x, y] of points) {
      const s = wheelScroller(x, y, axis);
      if (s && movers.some((m) => m.el === s)) return { x: x / w, y: y / h };
    }
    return axis === "sx"
      ? { x: (win.left + win.right) / 2 / w, y: (r.top + r.bottom) / 2 / h }
      : { x: (r.left + r.right) / 2 / w, y: (win.top + win.bottom) / 2 / h };
  }

  // An XHTML document keeps tagName lowercase.
  function htmlTag(el) {
    return getTagName.call(el).toUpperCase();
  }

  // False for a pseudo-class this Chromium lacks.
  function matches(el, sel) {
    try {
      return matchesSel.call(el, sel);
    } catch (e) {
      return false;
    }
  }

  // A top-layer box (modal dialog, open popover, fullscreen element) escapes every clip.
  function inTopLayer(el, style) {
    if (style.position !== "fixed" && style.position !== "absolute") return false;
    return [":modal", ":popover-open", ":fullscreen"].some((sel) => matches(el, sel));
  }

  // An open customizable select draws every child but a leading <button> in its
  // top-layer ::picker(select).
  function inPicker(el, child, i) {
    if (htmlTag(el) !== "SELECT" || !matches(el, ":open")) return false;
    return i > 0 || htmlTag(child) !== "BUTTON";
  }

  // A display: contents element has no box to position: its own text is in flow.
  function ownClip(clips, style) {
    if (style.display === "contents") return clips.flow;
    if (style.position === "absolute") return clips.abs;
    if (style.position === "fixed") return clips.fixed;
    return clips.flow;
  }

  function isSet(v) {
    return Boolean(v) && v !== "none";
  }

  // content-visibility: auto or hidden applies paint containment that computed contain omits.
  function paintContained(style) {
    return (
      /paint|strict|content/.test(style.contain || "") ||
      /auto|hidden/.test(style.contentVisibility || "")
    );
  }

  // Whether an element is the containing block of fixed descendants. Chromium ignores
  // transforms on inline boxes, and containment wherever it ignores overflow.
  function containsFixed(el, style) {
    // Computed will-change keeps the author's case and -webkit- aliases.
    const hints = (style.willChange || "")
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/^-webkit-/, ""));
    const hinted = (...props) => props.some((p) => hints.includes(p));
    if (isSet(style.filter) || isSet(style.backdropFilter) || hinted("filter", "backdrop-filter")) {
      return true;
    }
    if (style.display === "inline") return false;
    if (
      isSet(style.transform) ||
      isSet(style.translate) ||
      isSet(style.rotate) ||
      isSet(style.scale) ||
      isSet(style.perspective) ||
      style.transformStyle === "preserve-3d" ||
      hinted("transform", "translate", "rotate", "scale", "perspective", "transform-style")
    ) {
      return true;
    }
    return (
      overflowApplies(el, style) &&
      (/layout/.test(style.contain || "") || paintContained(style) || hinted("contain"))
    );
  }

  // A computed transform's 2D part as [a, b, c, d, e, f], or null for none.
  function matrix2d(v) {
    const m = /^matrix(3d)?\\(([^)]*)\\)$/.exec(v || "");
    if (!m) return null;
    const n = m[2].split(",").map(parseFloat);
    return m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n;
  }

  function multiply(p, q) {
    return [
      p[0] * q[0] + p[2] * q[1],
      p[1] * q[0] + p[3] * q[1],
      p[0] * q[2] + p[2] * q[3],
      p[1] * q[2] + p[3] * q[3],
      p[0] * q[4] + p[2] * q[5] + p[4],
      p[1] * q[4] + p[3] * q[5] + p[5],
    ];
  }

  // The 2D matrix of translate, rotate, scale and transform, applied in that order.
  function transformMatrix(style) {
    let t = [1, 0, 0, 1, 0, 0];
    if (isSet(style.translate)) {
      const [tx = 0, ty = 0] = style.translate.split(" ").map((v) => parseFloat(v) || 0);
      t = multiply(t, [1, 0, 0, 1, tx, ty]);
    }
    // Only a rotation about z is 2D: "45deg" or "z 45deg".
    const rot = /^(?:z )?(-?[\\d.]+)deg$/.exec(style.rotate || "");
    if (rot) {
      const a = (parseFloat(rot[1]) * Math.PI) / 180;
      t = multiply(t, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    }
    if (isSet(style.scale)) {
      const [sx = 1, sy = sx] = style.scale.split(" ").map(parseFloat);
      t = multiply(t, [sx, 0, 0, sy, 0, 0]);
    }
    const m = matrix2d(style.transform);
    return m ? multiply(t, m) : t;
  }

  // A nested <svg>'s rect bounds its content, not its viewport: its x/y/width/height in
  // the parent's user space, moved by its own transforms about its transform-origin.
  function nestedSvgViewport(el, style) {
    if (!(el instanceof SVGSVGElement) || !el.ownerSVGElement) return null;
    const m = el.parentNode.getScreenCTM?.();
    if (!m) return null;
    const x = el.x.animVal.value;
    const y = el.y.animVal.value;
    const w = el.width.animVal.value;
    const h = el.height.animVal.value;
    const t = transformMatrix(style);
    const [ox = 0, oy = 0] = (style.transformOrigin || "").split(" ").map((v) => parseFloat(v) || 0);
    const xs = [];
    const ys = [];
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      const qx = t[0] * (px - ox) + t[2] * (py - oy) + t[4] + ox;
      const qy = t[1] * (px - ox) + t[3] * (py - oy) + t[5] + oy;
      xs.push(m.a * qx + m.c * qy + m.e);
      ys.push(m.b * qx + m.d * qy + m.f);
    }
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
      sx: 1,
      sy: 1,
    };
  }

  // Padding box in viewport px, scrollbars excluded, and the scale (sx, sy) from layout
  // px to the rendered (transformed) box. A non-HTML clipper has no offset* to scale by:
  // an outer <svg> clips at its content box, a <foreignObject> at its rect.
  function paddingBox(el, style) {
    const vp = nestedSvgViewport(el, style);
    if (vp) return vp;
    const r = getBCR.call(el);
    // A quirks-mode body reports the viewport's client size, so its own borders measure it.
    if (htmlTag(el) === "BODY" && getOwnerDocument.call(el)?.compatMode === "BackCompat") {
      const border = (side) => parseFloat(style["border" + side + "Width"]) || 0;
      return {
        left: r.left + border("Left"),
        top: r.top + border("Top"),
        right: r.right - border("Right"),
        bottom: r.bottom - border("Bottom"),
        sx: 1,
        sy: 1,
      };
    }
    if (!(el instanceof HTMLElement)) {
      if (!(el instanceof SVGSVGElement)) {
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, sx: 1, sy: 1 };
      }
      const px = (prop) => parseFloat(style[prop]) || 0;
      const inset = (side) => px("border" + side + "Width") + px("padding" + side);
      const borderBox = style.boxSizing === "border-box";
      const lw = px("width") + (borderBox ? 0 : inset("Left") + inset("Right"));
      const lh = px("height") + (borderBox ? 0 : inset("Top") + inset("Bottom"));
      const sx = px("width") > 0 && lw > 0 ? r.width / lw : 1;
      const sy = px("height") > 0 && lh > 0 ? r.height / lh : 1;
      return {
        left: r.left + inset("Left") * sx,
        top: r.top + inset("Top") * sy,
        right: r.right - inset("Right") * sx,
        bottom: r.bottom - inset("Bottom") * sy,
        sx,
        sy,
      };
    }
    const ow = getOffsetWidth.call(el);
    const oh = getOffsetHeight.call(el);
    const sx = ow > 0 ? r.width / ow : 1;
    const sy = oh > 0 ? r.height / oh : 1;
    const left = r.left + getClientLeft.call(el) * sx;
    const top = r.top + getClientTop.call(el) * sy;
    return {
      left,
      top,
      right: left + getClientWidth.call(el) * sx,
      bottom: top + getClientHeight.call(el) * sy,
      sx,
      sy,
    };
  }

  // How far overflow-clip-margin moves a clip edge out of the clip box (the padding box,
  // or an outer <svg>'s content box). It applies only where the axis clips by
  // overflow: clip or by paint containment, and to overflow: clip only when both axes do.
  function clipMargin(el, style, overflow, side, scale) {
    if (overflow !== "clip" && overflow !== "visible") return 0;
    if (!paintContained(style) && (style.overflowX !== "clip" || style.overflowY !== "clip")) {
      return 0;
    }
    const v = style.overflowClipMargin || "";
    const len = parseFloat(v.replace(/^[a-z-]+/, "")) || 0;
    const padding = parseFloat(style["padding" + side]) || 0;
    let box = el instanceof SVGSVGElement ? padding : 0;
    if (v.startsWith("content-box")) box -= padding;
    if (v.startsWith("border-box")) box += parseFloat(style["border" + side + "Width"]) || 0;
    return (box + len) * scale;
  }

  // The root's overflow clips the viewport, not its box, and so does the body's unless
  // the root's is set or either has containment; the viewport is left to the clamp.
  // Chromium ignores overflow on inline HTML boxes and on table rows, row groups and
  // columns.
  function overflowApplies(el, style) {
    const tag = htmlTag(el);
    if (tag === "HTML") return false;
    if (tag === "BODY") {
      const doc = getOwnerDocument.call(el);
      const rootStyle = doc && doc.documentElement && window.getComputedStyle(doc.documentElement);
      if (!rootStyle) return false;
      const contained = (st) => isSet(st.contain) || paintContained(st);
      const rootClips = rootStyle.overflowX !== "visible" || rootStyle.overflowY !== "visible";
      if (!rootClips && !contained(rootStyle) && !contained(style)) return false;
    }
    if (el.namespaceURI === "http://www.w3.org/2000/svg") return true;
    return style.display !== "inline" && !/^table-(row|column|header|footer)/.test(style.display);
  }

  function childClips(el, style, clips, clip) {
    if (style.display === "contents") return clips;
    let inner = clip;
    if (overflowApplies(el, style)) {
      // content-visibility: hidden paints none of the content.
      if (style.contentVisibility === "hidden") {
        return clipsWithin(el, style, clips, { left: 0, top: 0, right: 0, bottom: 0 });
      }
      const paint = paintContained(style);
      const cx = paint || style.overflowX !== "visible";
      const cy = paint || style.overflowY !== "visible";
      if (cx || cy) {
        const p = paddingBox(el, style);
        const ox = style.overflowX;
        const oy = style.overflowY;
        const own = {
          left: cx ? p.left - clipMargin(el, style, ox, "Left", p.sx) : -Infinity,
          top: cy ? p.top - clipMargin(el, style, oy, "Top", p.sy) : -Infinity,
          right: cx ? p.right + clipMargin(el, style, ox, "Right", p.sx) : Infinity,
          bottom: cy ? p.bottom + clipMargin(el, style, oy, "Bottom", p.sy) : Infinity,
        };
        inner = intersect(clip, own);
        // inner.scrollers lists, outermost first, the clippers on the chain that a user
        // can scroll content past, with the axes they scroll along.
        const sx =
          (ox === "auto" || ox === "scroll") && getScrollWidth.call(el) > getClientWidth.call(el);
        const sy =
          (oy === "auto" || oy === "scroll") &&
          getScrollHeight.call(el) > getClientHeight.call(el);
        const scrollers = clip && clip.scrollers;
        inner.scrollers =
          sx || sy ? (scrollers || []).concat([{ el, sx, sy, win: own }]) : scrollers;
      }
    }
    return clipsWithin(el, style, clips, inner);
  }

  // The clips children get when \`el\` clips its content to \`inner\`.
  function clipsWithin(el, style, clips, inner) {
    const fixedBlock = containsFixed(el, style) || getTagName.call(el) === "foreignObject";
    return {
      flow: inner,
      abs: fixedBlock || style.position !== "static" ? inner : clips.abs,
      fixed: fixedBlock ? inner : clips.fixed,
    };
  }

  // A fieldset's overflow clips its content box, never its rendered legend: the first
  // <legend> child that is neither floated nor out of flow.
  function renderedLegend(el, kids) {
    if (htmlTag(el) !== "FIELDSET") return null;
    for (const kid of kids) {
      if (htmlTag(kid) !== "LEGEND") continue;
      const ks = window.getComputedStyle(kid);
      if (ks.cssFloat === "none" && ks.position !== "absolute" && ks.position !== "fixed") {
        return kid;
      }
    }
    return null;
  }

  // Painted extent of an element's own inline TEXT. A box-less element (display:contents,
  // or a zero-width box whose text overflows) has a 0x0 border box yet its text still
  // paints; a Range over its own text measures that. Measure ONLY the element's direct
  // text-node children — NOT selectNodeContents(el) over the whole subtree, which also
  // spans the still-laid-out boxes of visibility:hidden / opacity:0 element descendants
  // (they keep a layout box but paint nothing), oversizing the frame and mis-placing the
  // tap point. Returns 0x0 when an ancestor transform (e.g. scale(0)) or display:none
  // collapses the paint. walk() consults this only when the element has its own text.
  function contentFrame(el, clip) {
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
      return normRect(intersect(box, clip));
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
    // overflow:hidden container hides its in-flow content). With the default
    // overflow:visible, or overflow Chromium ignores, abs-positioned / overflowing /
    // floated descendants still paint, so walk() must descend and promote them
    // instead of cutting the subtree.
    return overflowApplies(el, style) && overflowClips(style);
  }

  // Whether the page hit-tests el or its content outside \`clip\`, where the clip would
  // cut it: content slotted into a closed shadow root paints where its unseen slot sits,
  // which may escape its host's clips. Integer client sizes put a clip edge up to a pixel
  // inside the true one, so a point must lie more than a pixel outside.
  function paintsOutside(el, clip) {
    const v = intersect(getBCR.call(el), { left: 0, top: 0, right: w, bottom: h });
    const e = {
      left: clip.left - 1,
      top: clip.top - 1,
      right: clip.right + 1,
      bottom: clip.bottom + 1,
    };
    const cx = (v.left + v.right) / 2;
    const cy = (v.top + v.bottom) / 2;
    // A shadow root's elementsFromPoint returns nodes of its own tree, where the
    // document's returns their host.
    const root = getRootNode ? getRootNode.call(el) : document;
    return [
      [(v.left + Math.min(v.right, e.left)) / 2, cy],
      [(Math.max(v.left, e.right) + v.right) / 2, cy],
      [cx, (v.top + Math.min(v.bottom, e.top)) / 2],
      [cx, (Math.max(v.top, e.bottom) + v.bottom) / 2],
    ].some(
      ([x, y]) =>
        x >= v.left &&
        x < v.right &&
        y >= v.top &&
        y < v.bottom &&
        (x < e.left || x >= e.right || y < e.top || y >= e.bottom) &&
        elementsAt(root, x, y).some((hit) => containsNode.call(el, hit) && carried(el, hit))
    );
  }

  // Whether el's own painting puts hit where it is: no box between them is fixed or
  // absolute, which would paint by its own containing block, escaping el's clips.
  function carried(el, hit) {
    for (let n = hit; n && n !== el; n = getParentNode.call(n)) {
      const position = window.getComputedStyle(n).position;
      if (position === "fixed" || position === "absolute") return false;
    }
    return true;
  }

  // Smallest normalized box covering every surviving child frame — the frame we give
  // a box-less wrapper we still emit, since it has no rect of its own.
  function unionFrame(children) {
    let minX = 1;
    let minY = 1;
    let maxRight = 0;
    let maxBottom = 0;
    for (const c of children) {
      // A child clipped or scrolled out of view has no extent to cover.
      if (c.frame.width <= 0 || c.frame.height <= 0) continue;
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

  function walk(el, depth, clips = NO_CLIP, unseenSlot = false) {
    if (truncated) return null;
    if (depth > MAX_DEPTH) return null;
    if (!(el instanceof Element)) return null;
    const style = window.getComputedStyle(el);
    if (hidden(el, style)) {
      pruned.add(el);
      return null;
    }
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

    if (inTopLayer(el, style)) clips = NO_CLIP;
    let clip = ownClip(clips, style);
    if (unseenSlot && clip && paintsOutside(el, clip)) {
      clips = NO_CLIP;
      clip = null;
    }
    const inner = childClips(el, style, clips, clip);
    if (htmlTag(el) === "SLOT") slotClips.set(el, inner);
    chains.set(el, inner.flow && inner.flow.scrollers);

    // Pierce open shadow roots — closed roots are unreachable by design.
    // Web-components-heavy apps (VS Code, every Lit/Polymer SPA) put their
    // interactive content under .shadowRoot, so without this descent describe
    // returns an empty body.
    // getShadowRoot via the prototype: a <form> with a control named "shadowRoot"
    // would otherwise return that control, and we'd re-walk its light-DOM children as
    // shadow content and duplicate the subtree. A real ShadowRoot is a DocumentFragment
    // (never a form), so its own .children read is safe.
    const shadowResults = [];
    const shadow = getShadowRoot.call(el);
    if (shadow) {
      for (const child of shadow.children) {
        const c = walk(child, depth + 1, inner);
        if (c) shadowResults.push(c);
      }
    }

    const childResults = [];
    const kids = getChildrenEls.call(el);
    const legend = renderedLegend(el, kids);
    // A custom element with no open shadow root may have a closed one, whose slots the
    // walker cannot see.
    const closedHost = !shadow && getTagName.call(el).includes("-");
    for (let i = 0; i < kids.length; i++) {
      const slot = getAssignedSlot.call(kids[i]);
      // A slot in a pruned subtree paints none of its assigned nodes.
      if (slot && !slotClips.has(slot) && inPruned(slot)) continue;
      const kidClips = inPicker(el, kids[i], i)
        ? NO_CLIP
        : slot && slotClips.has(slot)
          ? slotClips.get(slot)
          : kids[i] === legend
            ? clipsWithin(el, style, clips, clip)
            : inner;
      const c = walk(kids[i], depth + 1, kidClips, closedHost && !slot);
      if (c) childResults.push(c);
    }
    childResults.push(...shadowResults);

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
    let clipBounds;
    let cut;
    if (bl) {
      selfFrame = unionFrame(childResults);
      if (text && selfFrame.width <= 0 && selfFrame.height <= 0) {
        const cf = contentFrame(el, clip);
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
      selfFrame = frame(el, clip);
      const scs = clip && clip.scrollers;
      if (scs && selfFrame.width > 0 && selfFrame.height > 0) {
        const r = getBCR.call(el);
        // Integer client sizes put a clip edge up to a pixel inside the true one.
        const cutsX = scs.filter(
          (s) => s.sx && (s.win.left > r.left + 1 || s.win.right < r.right - 1)
        );
        const cutsY = scs.filter(
          (s) => s.sy && (s.win.top > r.top + 1 || s.win.bottom < r.bottom - 1)
        );
        if (cutsX.length || cutsY.length) {
          const win = {
            left: Math.max(0, ...cutsX.map((s) => s.win.left)),
            top: Math.max(0, ...cutsY.map((s) => s.win.top)),
            right: Math.min(w, ...cutsX.map((s) => s.win.right)),
            bottom: Math.min(h, ...cutsY.map((s) => s.win.bottom)),
          };
          clipBounds = normRect(win);
          if (getOwnerDocument.call(el) === document) {
            const vis = intersect(intersect(r, clip), { left: 0, top: 0, right: w, bottom: h });
            cut = { r: vis, scs, win, cutsX, cutsY };
          }
        }
      }
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
    if (clipBounds) {
      node.clipBounds = clipBounds;
      if (cut) cuts.push({ ...cut, node });
    }
    if (name) node.label = name;
    if (text && text !== name) node.value = text.slice(0, 200);
    if (id) node.identifier = id;
    if (clickable) node.clickable = true;
    if (isDisabled(el)) node.disabled = true;
    if (isChecked(el)) node.checked = true;
    if (isPassword(el)) node.password = true;
    if (scrollable) {
      node.scrollable = true;
      if (inner.flow) node.clipFrame = normRect(inner.flow);
    }
    // Input focus: el is its document's activeElement. Deliberately emitted to
    // EVERY describe consumer (the agent-facing tool as much as the flow type
    // directive's focus wait) — where the caret is is useful targeting info.
    // The body is excluded — it's the default holder when nothing is focused,
    // and its screen-spanning frame would satisfy any overlap check. A host
    // <iframe>/<frame> is excluded too: it is the outer document's
    // activeElement whenever focus merely sits inside its subdocument, and the
    // inner element (that document's own activeElement, checked per-document)
    // is the one that carries the flag — flagging both would double-report.
    if (!invisibleSelf) {
      const tag = getTagName.call(el);
      if (tag !== "IFRAME" && tag !== "FRAME") {
        const doc = getOwnerDocument.call(el);
        if (doc && getActiveElement.call(doc) === el && getDocBody.call(doc) !== el) {
          node.focused = true;
        }
      }
    }
    return node;
  }

  const root = walk(document.documentElement, 0) || {
    role: "html",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };
  for (const { node, r, scs, win, cutsX, cutsY } of cuts) {
    node.clipAnchors = {};
    if (cutsX.length) node.clipAnchors.x = wheelAnchor(r, scs, cutsX, win, "sx");
    if (cutsY.length) node.clipAnchors.y = wheelAnchor(r, scs, cutsY, win, "sy");
  }
  return JSON.stringify({ tree: root, truncated });
})()`;

// Exported for test/describe-chromium-script.test.ts, which evals it against a
// mock DOM to lock in the visibility/pruning rules.
export const DESCRIBE_DOM_SCRIPT = buildDescribeDomScript(DEFAULT_WALK_LIMITS);

export async function describeChromium(
  api: ChromiumCdpApi,
  limits: ChromiumWalkLimits = DEFAULT_WALK_LIMITS
): Promise<DescribeTreeData> {
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
    process.stderr.write(
      `[chromium-describe] tree truncated at MAX_NODES — page exceeds the walker's budget; consider scoping the inspection.\n`
    );
    data.hint =
      "describe hit the node budget (MAX_NODES) and returned a PARTIAL tree — some on-screen content is missing. Scope the inspection to a smaller region (scroll to or focus the relevant view) and describe again.";
  }
  return data;
}

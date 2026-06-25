import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { DescribeNode, DescribeTreeData } from "../contract";

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
 *  - Prune a node only when it is truly invisible (display:none, visibility:hidden,
 *    opacity:0) or its border box is zero-area AND it clips overflow. A zero-area
 *    box with the default overflow:visible still paints its descendants — so we
 *    traverse it and promote them instead of cutting the subtree. This covers
 *    display:contents wrappers (React Native Web nests content under them), the
 *    zero-height anchor of an absolutely-positioned dropdown/popover/portal, and
 *    float/overflow wrappers that collapse to a zero-height box. A collapsed
 *    overflow:hidden container genuinely hides its content, so it stays pruned.
 *  - Cap node count at 5000 — that, not depth, bounds the payload a runaway SPA
 *    would otherwise serialize past CDP's single Runtime.evaluate reply limit
 *    (~50MB). Cap depth at 60 purely to bound recursion: modern React DOMs
 *    (React Native Web, navigator/provider stacks) routinely nest 25+ levels
 *    before reaching leaf text, so a shallower cap silently clips real content.
 */
// Exported for test/describe-chromium-script.test.ts, which evals it against a mock
// DOM to lock in the visibility/pruning rules (the script runs in the renderer, so
// the rest of the suite can only mock its CDP response).
export const DESCRIBE_DOM_SCRIPT = `(() => {
  const MAX_DEPTH = 60;
  const MAX_NODES = 5000;
  let nodeBudget = MAX_NODES;
  let truncated = false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return JSON.stringify({ tree: null, error: "viewport is zero" });

  function nodeRole(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    return t;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 200);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = [];
      for (const id of ids) {
        const ref = document.getElementById(id);
        if (ref) parts.push((ref.textContent || "").trim());
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
    const t = el.getAttribute("title");
    if (t) return t.slice(0, 200);
    return null;
  }

  function ownText(el) {
    let s = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) s += child.nodeValue;
    }
    return s.replace(/\\s+/g, " ").trim();
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.href) return true;
    if (tag === "button") return true;
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (tag === "summary" || tag === "details") return true;
    if (el.hasAttribute("onclick")) return true;
    const role = el.getAttribute("role");
    if (role && /^(button|link|tab|menuitem|checkbox|radio|switch|option)$/i.test(role)) return true;
    const tabIndex = el.getAttribute("tabindex");
    if (tabIndex !== null && tabIndex !== "-1") return true;
    return false;
  }

  function isDisabled(el) {
    if (el.hasAttribute("disabled")) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  }

  function isChecked(el) {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      return el.checked;
    }
    const v = el.getAttribute("aria-checked");
    if (v === "true") return true;
    return false;
  }

  function isPassword(el) {
    return el instanceof HTMLInputElement && el.type === "password";
  }

  function isScrollable(el) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    const ox = style.overflowX;
    if (oy === "auto" || oy === "scroll" || ox === "auto" || ox === "scroll") {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) return true;
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
    return normRect(el.getBoundingClientRect());
  }

  // Painted extent of an element's own inline content. A box-less element
  // (display:contents, or a zero-width box whose text overflows) has a 0x0 border box
  // yet its text still paints; a Range measures that. Crucially it returns 0x0 when an
  // ancestor transform (e.g. scale(0)) collapses the paint, which is how we tell
  // genuinely-invisible content apart from merely box-less content.
  function contentFrame(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return normRect(r);
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
    const r = el.getBoundingClientRect();
    return r.width <= 0 || r.height <= 0;
  }

  function hidden(el, style) {
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return true;
    }
    // display:contents has no box but lays its children out normally — never prune it.
    if (style.display === "contents") return false;
    const r = el.getBoundingClientRect();
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
    if (nodeBudget <= 0) {
      truncated = true;
      return null;
    }
    nodeBudget--;

    const childResults = [];
    for (const child of el.children) {
      const c = walk(child, depth + 1);
      if (c) childResults.push(c);
    }

    // Pierce open shadow roots — closed roots are unreachable by design.
    // Web-components-heavy apps (VS Code, every Lit/Polymer SPA) put their
    // interactive content under .shadowRoot, so without this descent describe
    // returns an empty body.
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        const c = walk(child, depth + 1);
        if (c) childResults.push(c);
      }
    }

    // Same-origin iframes: pierce contentDocument if accessible. Cross-origin
    // contentDocument access throws SecurityError — swallowed silently so the
    // walker doesn't abort the whole tree.
    if (el.tagName === "IFRAME") {
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

    const text = ownText(el);
    const name = accessibleName(el);
    const clickable = isInteractive(el);
    const role = nodeRole(el);
    const bl = boxless(el, style);

    // A box-less element has no rect of its own. Its visible extent is whatever its
    // children span; with no surviving child, fall back to the painted extent of its
    // own inline content. If that is still zero-area it paints nothing — e.g. a
    // transform: scale(0) subtree, whose descendants all collapse — so it is invisible
    // and dropped. A box-less wrapper with one child and nothing of its own is just a
    // layer, so promote the child. (Clickable / named box-less nodes fall through and
    // are emitted with this child- or content-spanning frame.)
    let selfFrame;
    if (bl) {
      selfFrame = unionFrame(childResults);
      if (selfFrame.width <= 0 && selfFrame.height <= 0) {
        const cf = contentFrame(el);
        if (cf) selfFrame = cf;
      }
      if (childResults.length === 0 && selfFrame.width <= 0 && selfFrame.height <= 0) {
        return null;
      }
      if (!clickable && !name && !text && childResults.length === 1) {
        return childResults[0];
      }
    } else {
      selfFrame = frame(el);
    }

    // Prune structural wrappers with no info that just add a layer.
    // Keep them if they're roots/clickable/named/have text.
    if (
      depth > 0 &&
      childResults.length === 1 &&
      !clickable &&
      !name &&
      !text &&
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
    // getAttribute, not el.id: like .title, a named form control can clobber the .id
    // property to a DOM node, which would then break JSON.stringify of the tree.
    const id =
      el.getAttribute("id") ||
      el.getAttribute("data-testid") ||
      el.getAttribute("data-test-id");
    if (id) node.identifier = id;
    if (clickable) node.clickable = true;
    if (isDisabled(el)) node.disabled = true;
    if (isChecked(el)) node.checked = true;
    if (isPassword(el)) node.password = true;
    if (isScrollable(el)) node.scrollable = true;
    return node;
  }

  const root = walk(document.documentElement, 0) || {
    role: "html",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };
  return JSON.stringify({ tree: root, truncated });
})()`;

export async function describeChromium(api: ChromiumCdpApi): Promise<DescribeTreeData> {
  // Make sure the cached viewport is fresh — the script normalizes frames by
  // the live window dimensions, so any rescroll between calls is reflected.
  await api.refreshViewport();
  const raw = (await api.cdp.send("Runtime.evaluate", {
    expression: DESCRIBE_DOM_SCRIPT,
    returnByValue: true,
  })) as {
    result?: { value?: string };
    exceptionDetails?: { text?: string };
  };
  if (raw.exceptionDetails) {
    throw new Error(
      `Chromium describe failed: ${raw.exceptionDetails.text ?? "renderer evaluation threw"}`
    );
  }
  const payload = raw.result?.value;
  if (typeof payload !== "string") {
    throw new Error("Chromium describe: renderer returned no value");
  }
  let parsed: { tree?: DescribeNode | null; truncated?: boolean; error?: string };
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(
      `Chromium describe: could not parse renderer payload: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (parsed.error) {
    throw new Error(`Chromium describe: ${parsed.error}`);
  }
  if (!parsed.tree) {
    throw new Error("Chromium describe: empty tree");
  }
  if (parsed.truncated) {
    // Surface a server-side warning so a partial tree is visible to ops.
    // A flag in DescribeTreeData would be cleaner but the contract is shared
    // with iOS/Android and we don't want to widen it just for Chromium.
    process.stderr.write(
      `[chromium-describe] tree truncated at MAX_NODES — page exceeds the walker's budget; consider scoping the inspection.\n`
    );
  }
  return { tree: parsed.tree, source: "cdp-dom" };
}

import type { ElectronCdpApi } from "../../../blueprints/electron-cdp";
import type { DescribeNode, DescribeTreeData } from "../contract";

/**
 * In-page script that returns a JSON UI tree mirroring `DescribeNode`. We
 * collect ARIA role / accessible name, interactivity flags, and bounding
 * rects normalized to fractions of window.innerWidth/innerHeight (matching
 * the iOS/Android describe contract, so the same frame-centre tap math
 * applies on Electron).
 *
 * Choices:
 *  - Walk children plus open shadow roots and same-origin iframe documents so
 *    modern Electron apps (VS Code, Slack, custom-element-heavy SPAs) don't
 *    appear as empty pages.
 *  - Skip purely structural wrappers (anonymous single-child divs) so the
 *    tree stays small.
 *  - Treat anchors, buttons, inputs, [role=button], [onclick], [tabindex]≥0
 *    as `clickable: true` so the agent knows which nodes to tap.
 *  - Use rect.width/rect.height === 0 to prune invisible nodes (display:none
 *    yields a zero-sized rect; visibility:hidden does not, so we also
 *    short-circuit on computed `visibility: hidden` for the root walk).
 *  - Cap depth at 24 and node count at 5000 — a runaway SPA otherwise
 *    serializes a payload too large for CDP to deliver in a single
 *    Runtime.evaluate reply (~50MB practical limit).
 */
const DESCRIBE_DOM_SCRIPT = `(() => {
  const MAX_DEPTH = 24;
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
    const t = el.title;
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

  function frame(el) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, r.left / w));
    const y = Math.max(0, Math.min(1, r.top / h));
    const right = Math.max(0, Math.min(1, r.right / w));
    const bottom = Math.max(0, Math.min(1, r.bottom / h));
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    return true;
  }

  function walk(el, depth) {
    if (truncated) return null;
    if (depth > MAX_DEPTH) return null;
    if (!(el instanceof Element)) return null;
    if (!visible(el)) return null;
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
      frame: frame(el),
      children: childResults,
    };
    if (name) node.label = name;
    if (text && text !== name) node.value = text.slice(0, 200);
    const id = el.id || el.getAttribute("data-testid") || el.getAttribute("data-test-id");
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

export async function describeElectron(api: ElectronCdpApi): Promise<DescribeTreeData> {
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
      `Electron describe failed: ${raw.exceptionDetails.text ?? "renderer evaluation threw"}`
    );
  }
  const payload = raw.result?.value;
  if (typeof payload !== "string") {
    throw new Error("Electron describe: renderer returned no value");
  }
  let parsed: { tree?: DescribeNode | null; truncated?: boolean; error?: string };
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(
      `Electron describe: could not parse renderer payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed.error) {
    throw new Error(`Electron describe: ${parsed.error}`);
  }
  if (!parsed.tree) {
    throw new Error("Electron describe: empty tree");
  }
  if (parsed.truncated) {
    // Surface a server-side warning so a partial tree is visible to ops.
    // A flag in DescribeTreeData would be cleaner but the contract is shared
    // with iOS/Android and we don't want to widen it just for Electron.
    process.stderr.write(
      `[electron-describe] tree truncated at MAX_NODES — page exceeds the walker's budget; consider scoping the inspection.\n`
    );
  }
  return { tree: parsed.tree, source: "cdp-dom" };
}

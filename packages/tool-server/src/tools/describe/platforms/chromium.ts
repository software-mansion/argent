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

  // A page script's global named after a DOM interface (\`function Node\`, \`var Element =
  // 5\`, a top-level \`class HTMLElement\`) is in scope here, so these shadow it with the
  // builtins, taken from elements the document makes: no page binding replaces document.
  let docProto = Object.getPrototypeOf(document);
  while (!Object.getOwnPropertyDescriptor(docProto, "createElementNS")) {
    docProto = Object.getPrototypeOf(docProto);
  }
  const made = (ns, tag) =>
    Object.getPrototypeOf(docProto.createElementNS.call(document, ns, tag)).constructor;
  const HTMLInputElement = made("http://www.w3.org/1999/xhtml", "input");
  const HTMLTextAreaElement = made("http://www.w3.org/1999/xhtml", "textarea");
  const HTMLImageElement = made("http://www.w3.org/1999/xhtml", "img");
  const SVGSVGElement = made("http://www.w3.org/2000/svg", "svg");
  const HTMLSlotElement = made("http://www.w3.org/1999/xhtml", "slot");
  const HTMLElement = Object.getPrototypeOf(HTMLInputElement);
  const Element = Object.getPrototypeOf(HTMLElement);
  const Node = Object.getPrototypeOf(Element);

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
  const getLocalName = protoGetter(Element.prototype, "localName");
  const getNamespaceURI = protoGetter(Element.prototype, "namespaceURI");
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
  const getOffsetLeft = protoGetter(HTMLElement.prototype, "offsetLeft");
  const getOffsetTop = protoGetter(HTMLElement.prototype, "offsetTop");
  const getOffsetParent = protoGetter(HTMLElement.prototype, "offsetParent");
  const getAttr = Element.prototype.getAttribute;
  const hasAttr = Element.prototype.hasAttribute;
  const getBCR = Element.prototype.getBoundingClientRect;
  const matchesSel = Element.prototype.matches;
  // Document's named getter is [LegacyOverrideBuiltIns] (like a form's): a
  // <form name="activeElement"> shadows document.activeElement, so both focus
  // reads go through prototype accessors.
  const getOwnerDocument = protoGetter(Node.prototype, "ownerDocument");
  const getActiveElement = protoGetter(docProto, "activeElement");
  const getDocBody = protoGetter(docProto, "body");
  const getRootNode = Node.prototype.getRootNode;
  const docElementsFromPoint = docProto.elementsFromPoint;
  const slotAssignedNodes = HTMLSlotElement.prototype.assignedNodes;
  // A document's named getter can shadow elementsFromPoint; a shadow root has none.
  function elementsAt(root, x, y) {
    return getNodeType.call(root) === 9
      ? docElementsFromPoint.call(root, x, y)
      : root.elementsFromPoint(x, y);
  }

  function nodeRole(el) {
    const r = getAttr.call(el, "role");
    if (r) return r;
    const t = getTagName.call(el).toLowerCase();
    return t;
  }

  // aria-labelledby id -> trimmed target text, or null for a missing id. Not a Map: a
  // page script's own global Map shadows the builtin here.
  const labelTexts = Object.create(null);
  const NAME_MAX = 200;

  // A blank aria-labelledby name or aria-label falls through to the next source.
  function accessibleName(el) {
    const labelledBy = getAttr.call(el, "aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = [];
      for (const id of ids) {
        let text = labelTexts[id];
        if (text === undefined) {
          const ref = document.getElementById(id);
          text = labelTexts[id] = ref ? labelText(ref).trim() : null;
        }
        if (text) parts.push(text);
      }
      const name = parts.join(" ");
      if (name) return name.slice(0, NAME_MAX);
    }
    const aria = getAttr.call(el, "aria-label")?.trim();
    if (aria) return aria.slice(0, NAME_MAX);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.slice(0, NAME_MAX);
      // Chrome never names a text field by its value; describe does, so a filled one reads.
      // Never fall through to a password input's value: with no aria label or
      // placeholder (a floating/uncontrolled-label pattern) the typed secret
      // would become the node's label and reach every describe consumer.
      if (el.value && !isPassword(el)) return el.value.slice(0, NAME_MAX);
    }
    if (el instanceof HTMLImageElement && el.alt) return el.alt.slice(0, NAME_MAX);
    // getAttribute, not el.title: a <form> with a control named "title" clobbers the
    // .title property to return that element (not a string), and .slice() then throws,
    // aborting the whole describe. getAttribute always yields string | null.
    const t = getAttr.call(el, "title");
    if (t) return t.slice(0, NAME_MAX);
    return null;
  }

  // A <br> separates the words around it unless it is display:none (what a
  // display:contents <br> computes to), which leaves them joined on screen.
  // The nodeType check comes first: the Element getters throw on a Comment. An SVG
  // br or a createElementNS "BR" fails the name/namespace check and renders inline.
  function isRenderedBr(node) {
    return (
      getNodeType.call(node) === 1 &&
      getLocalName.call(node) === "br" &&
      getNamespaceURI.call(node) === "http://www.w3.org/1999/xhtml" &&
      window.getComputedStyle(node).display !== "none"
    );
  }

  // Whether an element is a non-atomic inline box, whose words Chromium runs on into its
  // neighbours' and whose overflow and transforms it ignores.
  function isInlineBox(style) {
    return /^(inline|ruby|ruby-text|inline list-item)$/.test(style.display);
  }

  // JS \\s, minus U+FEFF: a zero-width no-break space must not collapse to a visible one.
  const WHITESPACE = /[^\\S\\uFEFF]+/g;

  function ownText(el) {
    let s = "";
    for (const child of getChildNodes.call(el)) {
      // nodeType/nodeValue via the prototype getters, keeping the "every inherited
      // read goes through a captured getter" invariant whole: a child can be a
      // clobbering <form> whose named control shadows these to a control element.
      // (=== 3 already made a clobbered nodeType safe; this removes the lone
      // directly-read member so no read's safety rests on the comparison semantics.)
      if (getNodeType.call(child) === 3) s += getNodeValue.call(child);
      else if (isRenderedBr(child)) s += " ";
    }
    return s.replace(WHITESPACE, " ").trim();
  }

  // Chrome hides for any aria-hidden value but "false" and "undefined", in any ASCII case.
  function isAriaHidden(el) {
    const v = getAttr.call(el, "aria-hidden");
    return !!v && !/^(false|undefined)$/i.test(v);
  }

  // A node's children in the flat tree: an open shadow root's in place of the host's,
  // and a <slot>'s assigned nodes, else its fallback content.
  function flatChildNodes(node) {
    if (getNodeType.call(node) === 1) {
      const shadow = getShadowRoot.call(node);
      if (shadow) return getChildNodes.call(shadow);
      if (isSlot(node)) {
        const assigned = slotAssignedNodes.call(node);
        if (assigned.length) return assigned;
      }
    }
    return getChildNodes.call(node);
  }

  // An element's element children in the flat tree, but a closed root's host gives its
  // light children.
  function flatChildElements(el) {
    const shadow = getShadowRoot.call(el);
    if (shadow) return shadow.children;
    const assigned = isSlot(el) ? slotAssignedNodes.call(el) : [];
    return assigned.length
      ? assigned.filter((n) => getNodeType.call(n) === 1)
      : getChildrenEls.call(el);
  }

  function isSlot(el) {
    return (
      getLocalName.call(el) === "slot" && getNamespaceURI.call(el) === "http://www.w3.org/1999/xhtml"
    );
  }

  // An aria-labelledby target's text (text and CDATA) in the flat tree, read by a subset
  // of Chrome's accessible-name rules. An element reads as what a <select> or <textarea>
  // shows, a range widget's value or a listbox's aria-selected options; else as its
  // aria-label, an <img>'s alt or an SVG element's <title>; else as its ::before, content
  // and ::after, or as its title if those are blank (not an <img> with an alt). A
  // non-inline element, an <img> (but a presentational alt=""), an <svg> with content, an
  // SVG <style> or a <br> parts the words around it, and an SVG <style>'s text never
  // counts. Nor does the text of a <noscript>, or of a <script> or <style> with no box,
  // which parts words only under display:none. A shown target leaves out its
  // display:none, visibility:hidden, aria-hidden and inert subtrees, and SVG elements SVG
  // never renders (one it does not know, <metadata>, <script>); a hidden one reads them
  // all, and there any <svg> parts words, as does every element under display:none, which
  // has no layout to run inline in. Neither reads what layout skips: a closed <details>
  // past its first <summary>, a rendered <progress> or <meter>'s content, a
  // content-visibility:hidden box's content, a hidden chosen option, or a hidden ::before
  // or ::after (or any in an aria-hidden target). An
  // <input>'s value is not read. Laid-out text and ::before/::after strings take their
  // text-transform case.
  // Iterative: the target's depth has no MAX_DEPTH bound. The walk stops once more than
  // NAME_MAX non-whitespace characters are in, which settles the name accessibleName cuts.
  function labelText(root) {
    const rootStyle = window.getComputedStyle(root);
    let shown = rootStyle.visibility !== "hidden";
    let ariaHidden = false;
    let inert = false;
    // How many display:none elements enclose the walk's position.
    let unrendered = 0;
    for (let n = root; !unrendered && n && getNodeType.call(n) === 1; n = getParentNode.call(n)) {
      if (isInert(n)) inert = true;
      if (window.getComputedStyle(n).display === "none") {
        unrendered = 1;
        shown = false;
      } else if (isAriaHidden(n)) {
        shown = false;
        ariaHidden = true;
      }
    }
    const rootOptions = chosenOptions(root);
    const own =
      controlText(root) ?? rangeText(root, !unrendered) ?? (rootOptions ? null : altText(root));
    if (own !== null) return own;
    if (shown && inert) return "";
    let s = "";
    // Characters read into s that trim() keeps; a lower bound, as s only gains them.
    let seen = 0;
    const read = (text) => {
      s += text;
      seen += text.replace(/\\s/g, "").length;
    };
    // The laid-out style whose text-transform cases the text nodes being read, or null.
    let textCase = null;
    // Whether the element whose children are read is an inline box.
    let inInline = false;
    // The last laid-out character, which capitalize's first word depends on. As in Blink,
    // layout reads back through inline flow, and anything else is a space: the start of a
    // box that is not inline flow, a replaced element, and the end of a block-level box
    // in a block container (an anonymous block follows it).
    let laid = " ";
    const lay = (text) => {
      if (text) laid = lastChar(text);
    };
    // A ::before or ::after: its name read, and its strings laid out in its case.
    const readPseudo = (pseudo, parentStyle) => {
      if (!pseudo.inline) laid = " ";
      const strings = caseText(pseudo.strings, pseudo.style, laid);
      read(pseudo.alt ?? strings);
      lay(strings);
      if (pseudo.block && !isInlineBox(parentStyle)) laid = " ";
    };
    // Nodes, SPACE where a non-inline element's content ends (BLOCK where a block-level
    // one's ends in a block container), RENDERED where a display:none element's does, and
    // functions that finish an element's text.
    const SPACE = {};
    const BLOCK = {};
    const RENDERED = {};
    const stack = [];
    // A listbox's chosen options, each read only when it is laid out and shown.
    const pushOptions = (options, rendered) => {
      for (let i = options.length - 1; i >= 0; i--) {
        const style = window.getComputedStyle(options[i]);
        if (rendered && style.display !== "none" && style.visibility === "visible") {
          if (!isAriaHidden(options[i])) stack.push(SPACE, options[i]);
        }
      }
    };
    // An element's ::before, shown children and ::after, or its title if those are blank;
    // only the title when empty.
    const pushContent = (el, style, rendered, empty) => {
      const html = getNamespaceURI.call(el) === "http://www.w3.org/1999/xhtml";
      const tag = getLocalName.call(el);
      const title = getAttr.call(el, "title");
      const start = s.length;
      if (title && !(html && tag === "img" && hasAttr.call(el, "alt"))) {
        stack.push(() => {
          if (!s.slice(start).replace(WHITESPACE, "")) {
            s = s.slice(0, start) + " " + title + " ";
          }
        });
      }
      if (
        empty ||
        (rendered && html && /^(progress|meter)$/.test(tag)) ||
        (rendered &&
          style.contentVisibility === "hidden" &&
          !isInlineBox(style) &&
          style.display !== "contents")
      ) {
        return;
      }
      if (rendered && !ariaHidden && html && !REPLACED.test(tag)) {
        const before = pseudoText(el, "::before");
        if (before) readPseudo(before, style);
        const from = s.length;
        // A spaced pseudo-element is parted only from the element's other text, and a
        // block-level one also from what follows the element.
        stack.push(() => {
          const after = pseudoText(el, "::after");
          const filled = !!s.slice(from).replace(WHITESPACE, "");
          if (before?.spaced && (filled || after)) s = s.slice(0, from) + " " + s.slice(from);
          if (after) {
            if (after.spaced && (filled || before)) s += " ";
            readPseudo(after, style);
          }
          if (before?.block || after?.block) s += " ";
        });
      }
      if (rendered && html && tag === "details" && closedDetails(el)) {
        for (const child of getChildNodes.call(el)) {
          if (
            getNodeType.call(child) === 1 &&
            getLocalName.call(child) === "summary" &&
            getNamespaceURI.call(child) === "http://www.w3.org/1999/xhtml"
          ) {
            stack.push(child);
            break;
          }
        }
      } else {
        const kids = flatChildNodes(el);
        // Layout cases text; display:none content reads as authored.
        const kidsCase = rendered && CASED.test(style.textTransform) ? style : null;
        const kidsInline = style.display === "contents" ? inInline : isInlineBox(style);
        if (kidsCase !== textCase || kidsInline !== inInline) {
          const outerCase = textCase;
          const outerInline = inInline;
          stack.push(() => {
            textCase = outerCase;
            inInline = outerInline;
          });
          textCase = kidsCase;
          inInline = kidsInline;
        }
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    };
    if (rootOptions) pushOptions(rootOptions, !unrendered);
    else pushContent(root, rootStyle, !unrendered, false);
    while (stack.length) {
      const node = stack.pop();
      if (typeof node === "function") {
        node();
        continue;
      }
      // Past the cap only the open elements' functions, which can insert a space, still
      // change the cut name.
      if (seen > NAME_MAX) continue;
      if (node === SPACE || node === BLOCK) {
        s += " ";
        if (node === BLOCK) laid = " ";
        continue;
      }
      if (node === RENDERED) {
        unrendered--;
        continue;
      }
      const type = getNodeType.call(node);
      if (type === 3 || type === 4) {
        const text = caseText(getNodeValue.call(node), textCase, laid);
        read(text);
        lay(text);
        continue;
      }
      if (type !== 1) continue;
      const style = window.getComputedStyle(node);
      const ns = getNamespaceURI.call(node);
      const tag = getLocalName.call(node);
      const svg = ns === "http://www.w3.org/2000/svg";
      if (
        shown &&
        (style.display === "none" ||
          (svg &&
            (tag === "metadata" ||
              tag === "script" ||
              Object.prototype.toString.call(node) === "[object SVGElement]")))
      ) {
        continue;
      }
      if (shown && (style.visibility === "hidden" || isAriaHidden(node) || isInert(node))) {
        // Laid out but not read: an in-flow block-level box still parts the words around it.
        if (
          isBlockLevel(style) &&
          style.cssFloat === "none" &&
          !/^(absolute|fixed)$/.test(style.position)
        ) {
          s += " ";
        }
        laid = lastLaid(node, inInline) ?? laid;
        continue;
      }
      if (isRenderedBr(node)) {
        s += " ";
        laid = " ";
        continue;
      }
      const rendered = !unrendered && style.display !== "none";
      // Inline flow, which layout reads the previous character back through.
      const flow =
        style.display === "contents" ||
        (isInlineBox(style) &&
          !(ns === "http://www.w3.org/1999/xhtml" && REPLACED.test(tag)) &&
          !(svg && tag === "svg"));
      const blockEnd = isBlockLevel(style) && !inInline;
      if (!flow) laid = " ";
      const options = chosenOptions(node);
      const control = controlText(node);
      const content = control ?? rangeText(node, rendered) ?? (options ? null : altText(node));
      if (content !== null) {
        read(" " + content + " ");
        if (rendered) laid = lastLaid(node, inInline) ?? laid;
        continue;
      }
      if (options) {
        s += " ";
        stack.push(SPACE);
        pushOptions(options, rendered);
        continue;
      }
      // A shown <svg> holding at most whitespace reads as nothing: SVG drops that text.
      const emptySvg = svg && tag === "svg" && shown && !hasContent(node);
      // A <noscript> has no box while scripts run, nor a <script> or <style> undisplayed.
      const noBox =
        ns === "http://www.w3.org/1999/xhtml" &&
        (tag === "noscript" ||
          (/^(script|style)$/.test(tag) && (style.display === "none" || unrendered)));
      const svgStyle = svg && tag === "style";
      const img =
        ns === "http://www.w3.org/1999/xhtml" &&
        tag === "img" &&
        (getAttr.call(node, "alt") !== "" || !!getAttr.call(node, "title"));
      if (
        (!isInlineBox(style) && !noBox) ||
        img ||
        (svg && tag === "svg" && !emptySvg) ||
        svgStyle ||
        unrendered
      ) {
        s += " ";
        stack.push(rendered && blockEnd ? BLOCK : SPACE);
      }
      if (style.display === "none") {
        unrendered++;
        stack.push(RENDERED);
      }
      if (!noBox && !svgStyle) pushContent(node, style, rendered, emptySvg);
    }
    return s.replace(WHITESPACE, " ");
  }

  // Whether a node has an element child, or a text or CDATA child that is not all whitespace.
  function hasContent(node) {
    for (const child of getChildNodes.call(node)) {
      const type = getNodeType.call(child);
      if (type === 1) return true;
      if ((type === 3 || type === 4) && getNodeValue.call(child).replace(WHITESPACE, "")) {
        return true;
      }
    }
    return false;
  }

  // What a <select> or <textarea> shows, which its child text is not; null for others.
  function controlText(el) {
    if (getNamespaceURI.call(el) !== "http://www.w3.org/1999/xhtml") return null;
    const tag = getLocalName.call(el);
    if (tag === "textarea") return el.value || el.placeholder;
    if (tag !== "select") return null;
    let chosen = "";
    for (const option of el.selectedOptions) chosen += option.label + " ";
    return chosen;
  }

  // An element's aria-label, or an <img>'s alt, when it has one that is not blank; else an
  // SVG element's first <title> child's text, which Chrome takes even when blank.
  function altText(el) {
    const ns = getNamespaceURI.call(el);
    const img = ns === "http://www.w3.org/1999/xhtml" && getLocalName.call(el) === "img";
    const t = getAttr.call(el, "aria-label") || (img && getAttr.call(el, "alt"));
    if (t && t.trim()) return t;
    if (ns !== "http://www.w3.org/2000/svg") return null;
    for (const child of getChildNodes.call(el)) {
      if (
        getNodeType.call(child) === 1 &&
        getLocalName.call(child) === "title" &&
        getNamespaceURI.call(child) === "http://www.w3.org/2000/svg"
      ) {
        return getTextContent.call(child) || null;
      }
    }
    return null;
  }

  function isInert(el) {
    return (
      getNamespaceURI.call(el) === "http://www.w3.org/1999/xhtml" && hasAttr.call(el, "inert")
    );
  }

  // The roles Chrome knows; it passes over any other token. It also passes over an option,
  // listitem or treeitem outside its context, and an unnamed form or region; this takes them.
  const ROLES = Object.create(null);
  for (const role of (
    "alert alertdialog application article banner blockquote button caption cell checkbox " +
    "code columnheader combobox comment complementary contentinfo definition deletion dialog " +
    "directory document emphasis feed figure form generic grid gridcell group heading image " +
    "img insertion link list listbox listitem log main mark marquee math menu menubar " +
    "menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph " +
    "presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar " +
    "search searchbox sectionfooter sectionheader separator slider spinbutton status strong " +
    "subscript suggestion superscript switch tab table tablist tabpanel term textbox time " +
    "timer toolbar tooltip tree treegrid treeitem graphics-document graphics-object " +
    "graphics-symbol " +
    "doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink " +
    "doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion " +
    "doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph " +
    "doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref " +
    "doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagefooter " +
    "doc-pageheader doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna " +
    "doc-subtitle doc-tip doc-toc"
  ).split(" ")) {
    ROLES[role] = true;
  }

  // The first token of an element's role that Chrome knows, lowercased, else "".
  function ariaRole(el) {
    const role = getAttr.call(el, "role");
    for (const token of role ? role.trim().split(/\\s+/) : []) {
      const r = token.toLowerCase();
      if (ROLES[r] === true) return r;
    }
    return "";
  }

  // A range widget's value as Chrome reads it: its aria-valuetext, else its aria-valuenow
  // held to aria-valuemin and aria-valuemax, to 6 significant digits. A value that does
  // not parse reads as 0, and a missing aria-valuenow as Chrome's default for the role.
  // A rendered <progress> or <meter> is one unless its role is another: a <progress> reads
  // its aria-valuenow unheld, else its value if it has one, and a <meter>'s min, max and
  // value stand in for the missing attributes. null for other roles, and for a progressbar
  // without a value.
  function rangeText(el, rendered) {
    const tag = getLocalName.call(el);
    const native =
      rendered &&
      getNamespaceURI.call(el) === "http://www.w3.org/1999/xhtml" &&
      /^(progress|meter)$/.test(tag)
        ? tag
        : "";
    const role = ariaRole(el) || (native === "progress" ? "progressbar" : native);
    if (!/^(slider|scrollbar|spinbutton|meter|progressbar)$/.test(role)) return null;
    const text = getAttr.call(el, "aria-valuetext");
    if (text !== null) return text;
    const num = (name, missing) => {
      const v = getAttr.call(el, name);
      if (v === null) return missing;
      return /^[+-]?(\\d+\\.?\\d*|\\.\\d+)(e[+-]?\\d+)?$/i.test(v) ? Number(v) : 0;
    };
    let v = num("aria-valuenow", null);
    if (native === "progress") {
      if (v === null) {
        if (!hasAttr.call(el, "value")) return null;
        v = el.value;
      }
    } else {
      const spin = role === "spinbutton";
      const min = num("aria-valuemin", native ? el.min : spin ? -Infinity : 0);
      const max = num("aria-valuemax", native ? el.max : spin ? Infinity : 100);
      if (v !== null) v = Math.max(min, Math.min(max, v));
      else if (native) v = el.value;
      else if (role === "progressbar") return null;
      else v = role === "meter" ? min : spin ? 0 : (min + max) / 2;
    }
    const p = v.toPrecision(6);
    return /^[^e]*\\.[^e]*$/.test(p) ? p.replace(/\\.?0+$/, "") : p;
  }

  // A listbox's option children with aria-selected="true", or null when it is not a
  // listbox or has none.
  function chosenOptions(el) {
    if (ariaRole(el) !== "listbox") return null;
    const chosen = [];
    for (const child of flatChildNodes(el)) {
      if (
        getNodeType.call(child) === 1 &&
        ariaRole(child) === "option" &&
        /^true$/i.test(getAttr.call(child, "aria-selected") || "")
      ) {
        chosen.push(child);
      }
    }
    return chosen.length ? chosen : null;
  }

  // Whether a <details> hides its content: closed, unless the page shows its
  // ::details-content or makes it display:contents.
  function closedDetails(el) {
    if (hasAttr.call(el, "open")) return false;
    const content = window.getComputedStyle(el, "::details-content");
    return content.contentVisibility !== "visible" && content.display !== "contents";
  }

  // What a ::before or ::after shows, or null: the strings of its content outside
  // functions (counters, url()), and its alt text after a "/" (else null), which names it
  // in their place. Alt text and a non-inline box's text are spaced (a display:contents
  // or math box is inline); block marks a block-level box; style is the box's own.
  function pseudoText(el, which) {
    const style = window.getComputedStyle(el, which);
    if (style.display === "none" || style.visibility !== "visible") return null;
    const v = style.content;
    let text = "";
    let alt = null;
    let depth = 0;
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "/" && !depth) alt = "";
      else if (c === '"') {
        let str = "";
        // Computed strings escape only '"', the backslash (code 92) and, in hex, controls.
        for (i++; i < v.length && v[i] !== '"'; i++) {
          if (v.charCodeAt(i) !== 92) {
            str += v[i];
            continue;
          }
          let hex = "";
          while (hex.length < 6 && /[0-9a-f]/i.test(v[i + 1] || "")) hex += v[++i];
          if (!hex) str += v[++i];
          else {
            str += String.fromCodePoint(parseInt(hex, 16));
            if (v[i + 1] === " ") i++;
          }
        }
        if (depth) continue;
        if (alt === null) text += str;
        else alt += str;
      }
    }
    if (!(alt ?? text)) return null;
    const d = style.display;
    const inline = isInlineBox(style) || /^(contents|math)$/.test(d);
    return {
      strings: text,
      alt,
      inline,
      spaced: alt !== null || !inline,
      block: /^(block|flex|grid|table|flow-root|list-item|-webkit-box)( |$)/.test(d),
      style,
    };
  }

  const REPLACED = /^(img|input|video|audio|canvas|iframe|object|embed|progress|meter)$/;

  // The last character a node lays out, or null if it lays out nothing. A <br>, a replaced
  // element or <svg> (but a broken <img> with an alt), the start of a box and the end of a
  // block-level box in a block container (inline false: the node's parent does not run
  // inline) are a space.
  function lastLaid(start, inline) {
    // Triples: a kind (a node, its ::before or ::after, or the start of a box), the node,
    // and whether the node's or the pseudo-element's parent runs inline.
    const stack = [0, start, inline];
    while (stack.length) {
      const inl = stack.pop();
      const node = stack.pop();
      const kind = stack.pop();
      if (kind === 3) return " ";
      if (kind) {
        const p = pseudoText(node, kind === 1 ? "::before" : "::after");
        const end = !p
          ? null
          : p.block && !inl
            ? " "
            : p.strings
              ? lastChar(p.strings)
              : p.inline
                ? null
                : " ";
        if (end) return end;
        continue;
      }
      const type = getNodeType.call(node);
      if (type === 3 || type === 4) {
        const text = getNodeValue.call(node);
        if (text) return lastChar(text);
        continue;
      }
      if (type !== 1) continue;
      const style = window.getComputedStyle(node);
      if (style.display === "none") continue;
      const html = getNamespaceURI.call(node) === "http://www.w3.org/1999/xhtml";
      const tag = getLocalName.call(node);
      if (html && tag === "img") {
        const alt = !node.naturalWidth && getAttr.call(node, "alt");
        return alt ? lastChar(alt) : " ";
      }
      if ((html && (tag === "br" || REPLACED.test(tag))) || tag === "svg") return " ";
      const control = controlText(node);
      if (control !== null) return lastChar(control.trimEnd()) || " ";
      const inlineBox = isInlineBox(style);
      if (!inlineBox && style.display !== "contents") {
        if (isBlockLevel(style) && !inl) return " ";
        stack.push(3, null, false);
      }
      const kidsInline = style.display === "contents" ? inl : inlineBox;
      if (html) stack.push(1, node, inlineBox);
      for (const child of flatChildNodes(node)) stack.push(0, child, kidsInline);
      if (html) stack.push(2, node, inlineBox);
    }
    return null;
  }

  // A string's last code point.
  function lastChar(text) {
    const pair = text.slice(-2);
    return pair.codePointAt(0) > 0xffff ? pair : text.slice(-1);
  }

  // Whether a box is block-level, not inline-level.
  function isBlockLevel(style) {
    return !/^(inline|ruby|contents|math)/.test(style.display);
  }

  const CASED = /^(uppercase|lowercase|capitalize)/;
  // Text as a style's text-transform cases it under its lang; prev is the character before
  // it, which decides whether capitalize starts a word there.
  function caseText(text, style, prev) {
    const mode = style && CASED.exec(style.textTransform);
    if (!mode) return text;
    if (mode[1] === "capitalize") return capitalize(text, prev);
    const lang = /^"(.*)"$/.exec(style.webkitLocale || "");
    const upper = mode[1] === "uppercase";
    try {
      if (lang) return upper ? text.toLocaleUpperCase(lang[1]) : text.toLocaleLowerCase(lang[1]);
    } catch {
      // A lang that is no locale tag cases as no lang does.
    }
    return upper ? text.toUpperCase() : text.toLowerCase();
  }

  // Blink's capitalize: each ICU word of prev + text starts in its first code unit's
  // single-character title case. Text is kept as is where Intl.Segmenter is missing or is
  // a page's own that misbehaves.
  let wordSegmenter = null;
  function capitalize(text, prev) {
    try {
      if (!wordSegmenter) wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      let out = "";
      let at = 0;
      for (const { index } of wordSegmenter.segment(prev + text)) {
        if (index < prev.length) continue;
        const i = index - prev.length;
        out += text.slice(at, i) + titleCase(text[i]);
        at = i + 1;
      }
      return out + text.slice(at);
    } catch {
      return text;
    }
  }

  // A code unit's simple title case, which JS lacks: a DŽ, LJ, NJ or DZ digraph's is its
  // mixed-case form, Georgian Mkhedruli's is itself (not Mtavruli), a Greek letter with
  // ypogegrammeni's is its prosgegrammeni form, and otherwise it is the uppercase when
  // that is one character.
  function titleCase(c) {
    const code = c.charCodeAt(0);
    if (code >= 0x1c4 && code <= 0x1cc) return String.fromCharCode(code + 1 - ((code - 0x1c4) % 3));
    if (code >= 0x1f1 && code <= 0x1f3) return String.fromCharCode(0x1f2);
    if (code >= 0x10d0 && code <= 0x10ff) return c;
    if (code >= 0x1f80 && code <= 0x1faf && code % 16 < 8) return String.fromCharCode(code + 8);
    if (code === 0x1fb3 || code === 0x1fc3 || code === 0x1ff3) return String.fromCharCode(code + 9);
    const upper = c.toUpperCase();
    return upper.length === 1 ? upper : c;
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

  // Overflow clips a descendant only when the clipper is on its containing-block chain,
  // so an absolute or fixed box takes the clip in force at its containing block. Each
  // entry is the clip a child with that position gets.
  const NO_CLIP = { flow: null, abs: null, fixed: null };
  const NO_AREA = { left: 0, top: 0, right: 0, bottom: 0 };
  // Content a box skips paints nowhere, whatever its position.
  const SKIPPED = { flow: NO_AREA, abs: NO_AREA, fixed: NO_AREA };

  // An element-keyed map. A page's top-level \`class Map\` shadows only the bare name,
  // but \`var Map = ...\` replaces globalThis.Map (with Immutable.Map, say, whose set
  // returns a copy); unless it keeps object keys in place, a linear list stands in.
  function nodeMap() {
    try {
      const m = new globalThis.Map();
      const k = {};
      m.set(k, 1);
      if (m.has(k) && m.get(k) === 1 && !m.has({})) return m;
    } catch (e) {
      /* not a usable Map */
    }
    const keys = [];
    const vals = [];
    return {
      has: (k) => keys.indexOf(k) >= 0,
      get: (k) => vals[keys.lastIndexOf(k)],
      set: (k, v) => void (keys.push(k), vals.push(v)),
    };
  }

  // A slotted element paints where its <slot> sits in the shadow tree, so it takes the
  // clips in force there; each host's shadow tree is walked before its light children.
  const slotClips = nodeMap();
  // A rendered legend takes its fieldset's own clips, wherever in the DOM it sits.
  const legendClips = nodeMap();
  // Elements hidden() pruned: a slot inside one paints nothing.
  const pruned = nodeMap();
  function inPruned(node) {
    for (let n = node; n; n = getParentNode.call(n)) if (pruned.has(n)) return true;
    return false;
  }

  // Each walked element's scrollers, its own last when it scrolls; the elements a
  // scroller cuts are anchored once the whole tree has been walked.
  const chains = nodeMap();
  const cuts = [];
  // Each emitted node's unclipped extent and the scrollers measured against it.
  const extents = nodeMap();

  // An element's parent in the flat tree: its slot, else its parent, a shadow root's host.
  function flatParent(n) {
    const p = (getNodeType.call(n) === 1 && getAssignedSlot.call(n)) || getParentNode.call(n);
    return p && getNodeType.call(p) === 11 ? p.host : p;
  }

  // The innermost scroller along an axis on a walked element's chain.
  function chainScroller(el, axis) {
    const chain = chains.get(el) || [];
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i][axis]) return chain[i].el;
    return null;
  }

  // The scroller a wheel at (x, y) scrolls along an axis: the innermost on the
  // painted element's chain, the one Chrome latches to. Null where that is unknown:
  // over a frame, whose own document may take the wheel, or where a scroll container
  // short of that scroller, scrollable or not, keeps the wheel with its
  // overscroll-behavior on the axis. \`stop\` is the element that settled it: that frame
  // or container (\`kept\`), else the walked element whose chain was read.
  function wheelScroller(x, y, axis) {
    let hit = elementsAt(document, x, y)[0];
    for (let sr = hit && getShadowRoot.call(hit); sr; sr = getShadowRoot.call(hit)) {
      const deeper = sr.elementsFromPoint(x, y)[0];
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    if (hit && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(htmlTag(hit))) {
      return { scroller: null, stop: hit, kept: true };
    }
    const overscroll = axis === "sx" ? "overscrollBehaviorX" : "overscrollBehaviorY";
    let scroller;
    let stop = null;
    for (let n = hit; n; n = flatParent(n)) {
      if (scroller === undefined && chains.has(n)) {
        stop = n;
        scroller = chainScroller(n, axis);
        if (!scroller) break;
      }
      if (n === scroller) return { scroller, stop };
      const st = getNodeType.call(n) === 1 && window.getComputedStyle(n);
      const contains = st && (st[overscroll] === "contain" || st[overscroll] === "none");
      const clips = (o) => o !== "visible" && o !== "clip";
      if (contains && (clips(st.overflowX) || clips(st.overflowY))) {
        return { scroller: null, stop: n, kept: true };
      }
    }
    return { scroller: null, stop };
  }

  // Every cut under one cutter probes the same points.
  const probed = Object.create(null);
  function wheelProbe(x, y, axis) {
    const key = axis + x + "," + y;
    return probed[key] || (probed[key] = wheelScroller(x, y, axis));
  }

  // What a wheel at (x, y) that missed the movers landed on: the frame or container
  // keeping it, else the largest box around the point whose content wheels the same
  // scroller, short of a mover or one holding a mover (\`holders\`).
  function wheelBlocker(probe, holders, axis, x, y) {
    const over = (el) => {
      const b = getBCR.call(el);
      return b.left <= x && x <= b.right && b.top <= y && y <= b.bottom ? b : null;
    };
    let n = probe.stop;
    if (!n) return null;
    let box = over(n);
    if (probe.kept) return box;
    const target = chainScroller(n, axis);
    for (let p = flatParent(n); p && getNodeType.call(p) === 1; p = flatParent(p)) {
      if (holders.includes(p)) break;
      if (!chains.has(p) || chainScroller(p, axis) !== target) break;
      box = over(p) || box;
    }
    return box;
  }

  // Region q less rect b: the bands of q above, below, left and right of b.
  function outside(q, b) {
    const top = Math.max(q.top, b.top);
    const bottom = Math.min(q.bottom, b.bottom);
    return [
      { left: q.left, top: q.top, right: q.right, bottom: Math.min(q.bottom, b.top) },
      { left: q.left, top: Math.max(q.top, b.bottom), right: q.right, bottom: q.bottom },
      { left: q.left, top, right: Math.min(q.right, b.left), bottom },
      { left: Math.max(q.left, b.right), top, right: q.right, bottom },
    ].filter((v) => v.right - v.left >= 1 && v.bottom - v.top >= 1);
  }

  // A point where a wheel scrolls the element (visible part r) against a scroller
  // cutting it along the axis: one on its chain from the outermost cutter in, of
  // scrollers \`scs\`. Elsewhere the wheel may move an overlay's scroller, the element's
  // own, or one holding the cutter. The shown part of the innermost cutter's window is
  // tried first, its points farthest along the axis first: content scrolling under the
  // point mid-wheel takes the rest of it. A 3x3 grid of each window is tried, then,
  // for a few rounds, the parts of it left beside the boxes its missed points landed
  // on, so a strip too thin for the grid is still found. With no such point on screen,
  // the centre of the cut window \`win\` across the element.
  function wheelAnchor(r, scs, cutters, win, axis) {
    const movers = scs.slice(scs.indexOf(cutters[0])).filter((s) => s[axis]);
    const away = ([x, y]) =>
      axis === "sx" ? Math.max(r.left - x, x - r.right) : Math.max(r.top - y, y - r.bottom);
    const holders = [];
    for (const m of movers) for (let n = m.el; n; n = flatParent(n)) holders.push(n);
    // elementsFromPoint hits what meets the 1px box right of and below a point, a wheel
    // the box that holds it once edges snap to pixels: a point keeps that 1px box in q
    // where it can, and half a pixel past q's start.
    const span = (lo, hi, f) => Math.max(Math.min(lo + (hi - lo) * f, hi - 1), lo + 0.5);
    const at = (q, f, g) => [span(q.left, q.right, f), span(q.top, q.bottom, g)];
    // Probes past the grids, each an elementsFromPoint and a walk up its path.
    let spare = 24;
    for (let i = cutters.length - 1; i >= 0; i--) {
      let regions = [intersect(cutters[i].shown, { left: 0, top: 0, right: w, bottom: h })];
      for (let round = 0; round < 4 && regions.length; round++) {
        const points = [];
        for (const q of regions) {
          for (const f of [0.1, 0.5, 0.9]) {
            if (round) points.push([axis === "sx" ? at(q, f, 0.5) : at(q, 0.5, f), q]);
            else for (const g of [0.1, 0.5, 0.9]) points.push([at(q, f, g), q]);
          }
        }
        points.sort((a, b) => away(b[0]) - away(a[0]));
        const boxes = [];
        const blocked = [];
        for (const [[x, y], q] of points) {
          if (round && spare-- <= 0) break;
          const probe = wheelProbe(x, y, axis);
          if (movers.some((m) => m.el === probe.scroller)) return { x: x / w, y: y / h };
          const box = wheelBlocker(probe, holders, axis, x, y);
          if (box) {
            boxes.push(box);
            blocked.push(q);
          }
        }
        // Bounded: each box can split every part in four.
        regions = regions
          .filter((q) => blocked.includes(q))
          .flatMap((q) =>
            boxes.reduce((parts, b) => parts.flatMap((v) => outside(v, b)).slice(0, 8), [q])
          )
          .slice(0, 8);
      }
    }
    const [x, y] = [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
    if (movers.some((m) => m.el === wheelProbe(x, y, axis).scroller)) {
      return { x: x / w, y: y / h };
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
    if (isInlineBox(style)) return false;
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
    return !isInlineBox(style) && !/^table-(row|column|header|footer)/.test(style.display);
  }

  // Whether content-visibility: hidden skips an element's content.
  function skipsContent(el, style) {
    return (
      style.display !== "contents" &&
      style.contentVisibility === "hidden" &&
      overflowApplies(el, style)
    );
  }

  function childClips(el, style, clips, clip, legend) {
    if (style.display === "contents") return clips;
    if (skipsContent(el, style)) return clipsWithin(el, style, clips, NO_AREA);
    let inner = clip;
    if (overflowApplies(el, style)) {
      const paint = paintContained(style);
      const cx = paint || style.overflowX !== "visible";
      const cy = paint || style.overflowY !== "visible";
      if (cx || cy) {
        const p = paddingBox(el, style);
        if (legend) belowLegend(el, p, style, legend);
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
        // can scroll content past, with the axes they scroll along and the part of their
        // window the clips above leave showing.
        const sx =
          (ox === "auto" || ox === "scroll") && getScrollWidth.call(el) > getClientWidth.call(el);
        const sy =
          (oy === "auto" || oy === "scroll") &&
          getScrollHeight.call(el) > getClientHeight.call(el);
        const scrollers = clip && clip.scrollers;
        inner.scrollers =
          sx || sy ? (scrollers || []).concat([{ el, sx, sy, win: own, shown: inner }]) : scrollers;
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

  // A fieldset's rendered legend, which its overflow never clips: the first <legend>
  // among its flat-tree children, seen through display:contents boxes (slots included),
  // that generates a box and is neither floated nor out of flow. A display:contents
  // fieldset has none; the fieldset around it takes the legend.
  function renderedLegend(el, style) {
    return htmlTag(el) === "FIELDSET" && style.display !== "contents"
      ? firstLegend(el, style, flatChildElements(el), false)
      : null;
  }
  // unsure: kids sit under a box that may host a closed root, which can slot them
  // anywhere in its shadow tree.
  function firstLegend(el, style, kids, unsure) {
    for (const kid of kids) {
      const ks = window.getComputedStyle(kid);
      if (ks.display === "contents") {
        const closed = !getShadowRoot.call(kid) && canHostShadow(kid);
        const found = firstLegend(el, style, flatChildElements(kid), unsure || closed);
        if (found) return found;
      } else if (
        htmlTag(kid) === "LEGEND" &&
        ks.display !== "none" &&
        ks.cssFloat === "none" &&
        ks.position !== "absolute" &&
        ks.position !== "fixed" &&
        (!unsure || laidOutAsLegend(el, style, kid, ks))
      ) {
        return kid;
      }
    }
    return null;
  }

  // Whether layout put legend where a fieldset's rendered legend goes: over its
  // block-start border, short of the padding its flow content starts past. Offsets,
  // unlike rects, ignore transforms and scrolling.
  function laidOutAsLegend(el, style, legend, ls) {
    const px = (st, prop) => parseFloat(st[prop]) || 0;
    const op = getOffsetParent.call(legend);
    // The fieldset's padding edges in the legend's offset coordinates.
    let left = 0;
    let top = 0;
    if (op !== el) {
      if (!op || op !== getOffsetParent.call(el)) return false;
      left = getOffsetLeft.call(el) + px(style, "borderLeftWidth");
      top = getOffsetTop.call(el) + px(style, "borderTopWidth");
    }
    const right =
      left + getOffsetWidth.call(el) - px(style, "borderLeftWidth") - px(style, "borderRightWidth");
    const rel = ls.position === "relative";
    const x = getOffsetLeft.call(legend) - (rel ? px(ls, "left") : 0);
    const y = getOffsetTop.call(legend) - (rel ? px(ls, "top") : 0);
    const wm = style.writingMode;
    // How far past the block-start padding edge the legend's border box starts.
    const [into, pad] =
      wm === "horizontal-tb"
        ? [y - top, px(style, "paddingTop")]
        : wm.endsWith("rl")
          ? [right - x - getOffsetWidth.call(legend), px(style, "paddingRight")]
          : [x - left, px(style, "paddingLeft")];
    return into < pad;
  }

  // A fieldset's overflow (but not its paint containment) clips its content no nearer
  // its block-start side than where its rendered legend's margin box ends, as laid out: the
  // legend's border box at the fieldset's block-start edge, centred on a thicker border. A
  // relative or sticky offset or a transform moves only where the legend paints.
  function belowLegend(el, p, style, legend) {
    const f = getBCR.call(el);
    const ls = window.getComputedStyle(legend);
    const px = (st, prop) => parseFloat(st[prop]) || 0;
    // How far past the border-box edge the legend's margin box ends, unscaled.
    const end = (border, size, margin) =>
      Math.max(0, (px(style, border) - size) / 2) + size + px(ls, margin);
    const wm = style.writingMode;
    if (wm === "horizontal-tb") {
      if (style.overflowY === "visible") return;
      const h = getOffsetHeight.call(legend);
      p.top = Math.max(p.top, f.top + end("borderTopWidth", h, "marginBottom") * p.sy);
    } else if (style.overflowX !== "visible") {
      const w = getOffsetWidth.call(legend);
      if (wm.endsWith("rl")) {
        p.right = Math.min(p.right, f.right - end("borderRightWidth", w, "marginLeft") * p.sx);
      } else {
        p.left = Math.max(p.left, f.left + end("borderLeftWidth", w, "marginRight") * p.sx);
      }
    }
  }

  // Painted extent of an element's own inline TEXT. A box-less element (display:contents,
  // or a zero-width box whose text overflows) has a 0x0 border box yet its text still
  // paints; a Range over its own text measures that. Measure ONLY the element's direct
  // text-node children — NOT selectNodeContents(el) over the whole subtree, which also
  // spans the still-laid-out boxes of visibility:hidden / opacity:0 element descendants
  // (they keep a layout box but paint nothing), oversizing the frame and mis-placing the
  // tap point. Null when an ancestor transform (e.g. scale(0)) or display:none
  // collapses the paint. walk() consults this only when the element has its own text.
  function contentBox(el) {
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
      return box;
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
  // which may escape its host's clips. Chrome hit-tests clipped content across its
  // clippers' borders too, so a point must lie outside their border boxes; and integer
  // client sizes put a clip edge up to a pixel inside the true one, so more than a pixel
  // outside.
  function paintsOutside(el, clip) {
    const v = intersect(getBCR.call(el), { left: 0, top: 0, right: w, bottom: h });
    // Nothing in view outside the clip to probe; most calls end here.
    if (v.left >= v.right || v.top >= v.bottom) return false;
    if (
      v.left >= clip.left &&
      v.right <= clip.right &&
      v.top >= clip.top &&
      v.bottom <= clip.bottom
    ) {
      return false;
    }
    const b = clipperBorders(getParentNode.call(el)) || clip;
    const e = {
      left: Math.min(clip.left, b.left) - 1,
      top: Math.min(clip.top, b.top) - 1,
      right: Math.max(clip.right, b.right) + 1,
      bottom: Math.max(clip.bottom, b.bottom) + 1,
    };
    const cx = (v.left + v.right) / 2;
    const cy = (v.top + v.bottom) / 2;
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
        carriesHit(el, x, y)
    );
  }

  // Whether attachShadow accepts el: a custom element or one of the DOM spec's listed
  // HTML elements.
  function canHostShadow(el) {
    if (getNamespaceURI.call(el) !== "http://www.w3.org/1999/xhtml") return false;
    const name = getLocalName.call(el);
    return (
      name.includes("-") ||
      /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(
        name
      )
    );
  }

  function isHtml(el, name) {
    return (
      getLocalName.call(el) === name && getNamespaceURI.call(el) === "http://www.w3.org/1999/xhtml"
    );
  }

  // The border boxes of n and its flat-tree ancestors that clip their content,
  // intersected; null when none does. Memoized: siblings share every ancestor.
  const clipperBoxes = nodeMap();
  function clipperBorders(n) {
    if (!n || getNodeType.call(n) !== 1) return null;
    if (clipperBoxes.has(n)) return clipperBoxes.get(n);
    const st = window.getComputedStyle(n);
    const own =
      overflowApplies(n, st) && (overflowClips(st) || paintContained(st)) ? getBCR.call(n) : null;
    const borders = intersect(clipperBorders(flatParent(n)), own);
    clipperBoxes.set(n, borders);
    return borders;
  }

  // The elements hit at (x, y) in root's tree and the open shadow trees under it. A tree
  // lists a host for anything its shadow tree paints, a fixed popup included, so each
  // host gives way to its shadow root's hits, which list it only where its own box is
  // hit; the rest of root's tree there is root's own list's.
  function hitsAt(root, x, y) {
    const hits = [];
    for (const hit of elementsAt(root, x, y)) {
      const sr = getRootNode.call(hit) === root && getShadowRoot.call(hit);
      if (!sr) {
        hits.push(hit);
        continue;
      }
      for (const n of hitsAt(sr, x, y)) {
        if (n === hit || getRootNode.call(n) !== root) hits.push(n);
      }
    }
    return hits;
  }

  // Whether an element hit at (x, y) is in el's flat tree and el's own painting puts it
  // there: no box between them is fixed or absolute, which would paint by its own
  // containing block, escaping el's clips. Each point's carriers are found once: stacked
  // content probes the same points.
  const carriersAt = Object.create(null);
  function carriesHit(el, x, y) {
    const key = x + "," + y;
    let carriers = carriersAt[key];
    if (!carriers) {
      carriers = carriersAt[key] = nodeMap();
      // A loop, not recursion: a hit can sit under thousands of display:contents boxes.
      for (const hit of hitsAt(document, x, y)) {
        for (let n = hit; n && !carriers.has(n); n = carrierParent(n)) carriers.set(n, true);
      }
    }
    return carriers.has(el);
  }

  // The element that carries whatever n carries: its flat parent, unless n is fixed or
  // absolute. Memoized: every probe point can hit a page's whole ancestor stack.
  const carrierParents = nodeMap();
  function carrierParent(n) {
    if (carrierParents.has(n)) return carrierParents.get(n);
    const position = window.getComputedStyle(n).position;
    const p = position === "fixed" || position === "absolute" ? null : flatParent(n);
    const carrier = p && getNodeType.call(p) === 1 ? p : null;
    carrierParents.set(n, carrier);
    return carrier;
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
      pruned.set(el, true);
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
    const kids = getChildrenEls.call(el);
    const legend = renderedLegend(el, style);
    if (legend) legendClips.set(legend, clipsWithin(el, style, clips, clip));
    const inner = childClips(el, style, clips, clip, legend);
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
        const c = walk(child, depth + 1, legendClips.has(child) ? legendClips.get(child) : inner);
        if (c) shadowResults.push(c);
      }
    }

    const childResults = [];
    // An element with no open shadow root may have a closed one, whose slots the walker
    // cannot see.
    const closedHost = !shadow && canHostShadow(el);
    // A closed <details> lays out only its first <summary> child.
    const closed = isHtml(el, "details") && closedDetails(el);
    const summary = closed ? Array.prototype.find.call(kids, (k) => isHtml(k, "summary")) : null;
    for (let i = 0; i < kids.length; i++) {
      const slot = getAssignedSlot.call(kids[i]);
      // A slot in a pruned subtree paints none of its assigned nodes.
      if (slot && !slotClips.has(slot) && inPruned(slot)) continue;
      const kidClips =
        closed && kids[i] !== summary
          ? SKIPPED
          : inPicker(el, kids[i], i)
            ? NO_CLIP
            : legendClips.has(kids[i])
              ? legendClips.get(kids[i])
              : slot && slotClips.has(slot)
                ? slotClips.get(slot)
                : inner;
      const c = walk(kids[i], depth + 1, kidClips, closedHost && !slot);
      if (c) childResults.push(c);
    }
    childResults.push(...shadowResults);

    // A visibility:hidden element paints nothing itself, but a descendant can override
    // visibility back to visible, so walk() descended instead of pruning (see hidden()).
    // Suppress this element's own paint — its text / name / interactivity are invisible —
    // and treat it as box-less so it contributes no box of its own: it survives only
    // through, and is framed by, whatever visible descendants it has.
    const invisibleSelf = style.visibility === "hidden";
    const text = invisibleSelf || closed || skipsContent(el, style) ? "" : ownText(el);
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
    const scs = clip && clip.scrollers;
    // Unclipped extent: a box-less element's spans its children under the same scrollers.
    let r = null;
    if (bl) {
      selfFrame = unionFrame(childResults);
      for (const c of scs ? childResults : []) {
        const e = extents.get(c);
        if (!e || e.scs !== scs) continue;
        r = !r
          ? e.r
          : {
              left: Math.min(r.left, e.r.left),
              top: Math.min(r.top, e.r.top),
              right: Math.max(r.right, e.r.right),
              bottom: Math.max(r.bottom, e.r.bottom),
            };
      }
      if (text && selfFrame.width <= 0 && selfFrame.height <= 0) {
        const box = contentBox(el);
        if (box) {
          selfFrame = normRect(intersect(box, clip));
          r = box;
        }
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
      r = getBCR.call(el);
      selfFrame = normRect(intersect(r, clip));
    }
    if (scs && r && selfFrame.width > 0 && selfFrame.height > 0) {
      // Integer client sizes put a clip edge up to a pixel inside the true one.
      const cutsX = scs.filter(
        (s) => s.sx && (s.win.left > r.left + 1 || s.win.right < r.right - 1)
      );
      const cutsY = scs.filter(
        (s) => s.sy && (s.win.top > r.top + 1 || s.win.bottom < r.bottom - 1)
      );
      if (cutsX.length || cutsY.length) {
        // The part of each cutter's window that the clips above it leave showing.
        const win = {
          left: Math.max(0, ...cutsX.map((s) => s.shown.left)),
          top: Math.max(0, ...cutsY.map((s) => s.shown.top)),
          right: Math.min(w, ...cutsX.map((s) => s.shown.right)),
          bottom: Math.min(h, ...cutsY.map((s) => s.shown.bottom)),
        };
        clipBounds = normRect(win);
        const vis = intersect(intersect(r, clip), { left: 0, top: 0, right: w, bottom: h });
        cut = { r: vis, scs, win, cutsX, cutsY };
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
    if (scs && r) extents.set(node, { r, scs });
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
    // activeElement whenever focus merely sits anywhere inside its
    // subdocument, so it does not mark where the caret is.
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

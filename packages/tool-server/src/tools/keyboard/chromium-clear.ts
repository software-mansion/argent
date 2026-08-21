/**
 * The Chromium `clear`: select the focused field's contents and delete them,
 * then confirm it actually happened.
 *
 * Split out of `platforms/chromium.ts` because the confirmation is most of the
 * work. On this backend a clear can silently do nothing in more ways than the
 * key dispatch can report — `Input.dispatchKeyEvent` resolves successfully for
 * every one of them (measured against Chrome 150; the CDP reply carries no
 * error):
 *
 *   - nothing editable holds focus (a tap that missed its target) — Blink's
 *     `selectAll` is not scoped to a field, so it selects the whole DOCUMENT
 *     and `deleteBackward` then no-ops for want of an editing host;
 *   - the page cancels the key in a `keydown` handler;
 *   - a rich-text editor (Lexical/ProseMirror/Slate) cancels the `beforeinput`;
 *   - the field is `readonly`;
 *   - the embedded Chromium predates the `commands` parameter, which CDP
 *     ignores silently along with any other unknown field.
 *
 * Reporting `cleared: true` through any of those is the silent-no-op class this
 * parameter exists to prevent (issue #449) — and the one a combined
 * `{ clear, text }` turns into corrupt data, since the new text then lands on
 * the value that was supposed to be gone. Chromium is also the one backend
 * where checking is nearly free: `evaluate` is already on `ChromiumCdpApi`.
 *
 * So the field is read before and after: a clear that cannot take effect is
 * refused before anything is dispatched (which also avoids leaving a
 * document-wide selection behind), and one that had no effect is reported as
 * the failure it is.
 *
 * Where the page cannot be read at all — `evaluate` throws, or focus sits in a
 * cross-origin iframe whose document is unreachable — this degrades to
 * best-effort and dispatches anyway, matching how the flow `type` directive
 * treats an unconfirmable focus (`flow-actions.ts` `waitForFocus`). Refusing
 * there would break clears that work today for the sake of a check that is
 * merely blind.
 *
 * What it still cannot see, all measured on Chrome 150 and all erring toward a
 * silent success rather than a false failure:
 *
 *   - a page that reacts LATER than the settle. A field restoring its value
 *     120ms after being emptied reads as empty and reports a clean replacement.
 *   - a split where the page also LENGTHENS the value. The split check needs the
 *     value to be wrong as well as the deliveries short, and a format-as-you-type
 *     field that turns `50` into `$5.00` while sending the `0` elsewhere holds
 *     MORE than was sent, which is not one of the two ways to be wrong.
 *   - residue rendered without an element the count recognises — an `<a>` drawn
 *     entirely by a CSS `background-image`. Widening the embed selector far
 *     enough to catch it would start counting the structural leftovers of a
 *     genuinely empty editor, which fails clears that worked.
 *
 * The converse — a page that SHORTENS what it receives (stripping separators,
 * trimming, `maxlength`) — used to be indistinguishable from a real split and was
 * reported as one. It no longer is: every character was still delivered to the
 * field, which is the question the split check asks first. See the guard in
 * `platforms/chromium.ts`.
 */
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { InvalidToolInputError } from "../../utils/capability";

// The probe parks the element it resolved on `window` so the re-read afterwards
// can measure THAT element rather than whatever holds focus by then.
//
// The slot name is generated per call, not fixed. Two reasons, both measured:
// nothing serializes tool calls against a device (the CDP client writes
// immediately and the registry hands concurrent calls the same session), so two
// clears sharing one slot interleave — B's probe overwrites A's element, or B's
// release deletes the slot before A reads it and A reports a silent success. And
// a fixed name is a slot the page can squat on: a non-writable decoy property
// made every clear on that page report success forever. A fresh name per call
// makes both far harder to hit. (`crypto.randomUUID` is the same shape
// `cdp-client`'s `evaluateWithBinding` uses to key its own callbacks.)
export function newTargetHandle(): string {
  return `__argentKeyboardClearTarget_${randomUUID().replace(/-/g, "")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The per-call properties the probes leave on page objects, all derived from the
 * target handle so they are unique per call for the same reasons — see
 * `newTargetHandle`. Every one of them is dropped again on the release pass.
 *
 *   - `embed`: stamped on each embedded element found BEFORE the clear, so the
 *     re-read can recognise THAT element rather than count its replacement.
 *   - `ins` / `insFn`: on the target itself — how many characters were delivered
 *     INTO it, and the listener that counts them.
 *   - `was`: on the target itself — the value it held before the clear.
 */
const pageMarks = (handle: string) => ({
  embed: `${handle}_embed`,
  count: `${handle}_ins`,
  listener: `${handle}_insFn`,
  applied: `${handle}_app`,
  appliedListener: `${handle}_appFn`,
  wasValue: `${handle}_was`,
});

/**
 * Whether Blink lays this element out — the one test both halves of the residue
 * measurement apply, so it is declared once, before either of them.
 *
 * Emitted ahead of `countEmbedsFns` in both probes and ahead of
 * `EDITABLE_TEXT_FN` in the one that measures text. A page-side `const` is
 * declared in the probe's single IIFE scope, so it can be spelled exactly once
 * per probe — hence its own constant rather than a copy inside each user.
 */
const IS_RENDERED_FN = `
  const isRendered = (el) => {
    try {
      // The top-level view's \`getComputedStyle\` resolves an element in a
      // same-origin subframe correctly (measured on Chrome 148), so the parked
      // element's own document does not have to be reached for.
      const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
      if (!style) return true;
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse";
    } catch (e) {
      // Unreadable style counts as rendered: this measurement exists to CATCH
      // residue, so anything it cannot judge has to stay in the count.
      return true;
    }
  };`;

/**
 * Page-side helpers, inlined into both probes: the content the element holds
 * that `textContent` cannot see, identified rather than merely counted.
 *
 * A non-form target is measured by its text, so anything carrying no text
 * node — an `<img>`, a `<video>`/`<canvas>`/`<svg>`, an `<hr>`, an
 * attachment chip, a table — measures 0 and a clear that emptied nothing reports
 * success (measured on Chrome 150: an `<img>`-only editor returned
 * `cleared: true` with the image untouched, 7/7).
 *
 * Two families count, and neither is a structural leftover. The tag list is
 * embedded/replaced content. `contenteditable="false"` is how every rich-text
 * editor marks an ATOMIC embed — a mention pill, an attachment chip, a
 * CSS-rendered token — which is exactly the content that survives a cancelled
 * delete while contributing no text. `<br>`, `<div>`, `<p>`, `<span>` and
 * `<font>` are deliberately absent: `<p><br></p>` is the EMPTY state of Blink,
 * Quill, Lexical and TinyMCE, and counting it would fail every clear that
 * actually worked.
 *
 * Residue is decided by IDENTITY, not by comparing a count across the clear.
 * Counting cannot tell the two states apart when both halves are ordinary:
 * an editor holding one atomic embed (a mention pill) that inserts its own
 * placeholder ELEMENT once it becomes empty — Slate renders its placeholder as a
 * `contenteditable="false"` span inside the editable, ProseMirror's widget
 * decorations are `contenteditable="false"` by default — goes 1 → 1 across a
 * clear that worked perfectly, and the count then reads as "the same content
 * survived". Measured on Chrome 151, 3/3: the pill and the text were gone, the
 * placeholder was in their place, and the clear was reported as a permanent hard
 * failure with the requested `text` never typed — permanent, because the
 * placeholder comes back on every retry.
 *
 * So the BEFORE pass stamps every embed it finds and the re-read counts only the
 * stamped ones still inside the field. A replacement the page inserted carries no
 * stamp; an `<img>` whose delete the page cancelled carries one and is still
 * found. The stamp is dropped again when the target handle is released, so a
 * field cleared repeatedly does not accumulate one property per call.
 *
 * The one shape this cannot see: an embed whose own object refuses the stamp
 * (a frozen element). It then re-reads as unstamped and counts as gone, which
 * errs toward a silent success — the same direction as everything else this
 * measurement cannot catch.
 */
const countEmbedsFns = (mark: string) => `
  const EMBED_MARK = ${JSON.stringify(mark)};
  const EMBED_TAGS = "img,video,audio,canvas,svg,embed,object,iframe,hr,input,select," +
    "textarea,button,picture,math,table";
  // An embed Blink does not lay out is neither selected nor deleted, exactly as
  // for the TEXT it does not render — so counting one makes a clear that WORKED
  // report failure, and permanently, since every retry re-stamps the same node
  // (measured on Chrome 151: \`hello\` plus a \`display: none\` <img> inside a
  // contenteditable raised KEYBOARD_CLEAR_INEFFECTIVE with the editor already
  // empty of text, against a matched control without the style that cleared and
  // typed correctly). \`input[type=hidden]\` is \`display: none\` by the UA
  // stylesheet and is in EMBED_TAGS, so on a \`body[contenteditable]\` /
  // designMode page one CSRF token or analytics iframe was enough to make every
  // clear a hard failure.
  //
  // The ANCESTORS are walked because this query is flat while the text walk
  // prunes from the top: \`display: none\` on a wrapper does not compute onto its
  // children (an element outside the rendering tree keeps its own \`display\`), so
  // asking the embed alone would miss every nested one. The walk stops at the
  // queried root, which \`querySelectorAll\` guarantees is an ancestor.
  const embedRendered = (el, root) => {
    for (let node = el; node && node !== root; node = node.parentElement) {
      if (!isRendered(node)) return false;
    }
    return true;
  };
  const embedsIn = (node, isFormControl) => {
    // A <textarea>'s child nodes are its DEFAULT value and never track \`value\`,
    // so counting them would report a cleared field as still full.
    if (isFormControl || !node || !node.querySelectorAll) return [];
    try {
      // \`i\` — the Selectors 4 case-insensitivity flag. An attribute selector's
      // VALUE match is case-sensitive by default, and \`contenteditable\` is an
      // enumerated attribute, so \`FALSE\` is valid and browsers honour it (it is
      // what HTML pasted from Word/Outlook and older serializers produces).
      // Without the flag such a subtree was skipped by the text walk, which
      // lowercases, AND missed by this count — invisible to both halves of the
      // verification, so a page that cancelled the edit reported \`cleared: true\`
      // with the pill untouched (measured on Chrome 148, against a matched
      // lowercase control that was correctly refused).
      const found = node.querySelectorAll(EMBED_TAGS + ",[contenteditable=false i]");
      const kept = [];
      for (let i = 0; i < found.length; i++) {
        if (embedRendered(found[i], node)) kept.push(found[i]);
      }
      return kept;
    } catch (e) {
      return [];
    }
  };
  // BEFORE: stamp each embed, so the re-read can tell it from a replacement.
  const stampEmbeds = (node, isFormControl) => {
    const seen = embedsIn(node, isFormControl);
    for (let i = 0; i < seen.length; i++) {
      try { seen[i][EMBED_MARK] = true; } catch (e) {}
    }
    return seen.length;
  };
  // AFTER: how many of the STAMPED embeds are still inside the field. Querying
  // within the element is itself the containment test — an embed the delete
  // removed is not found at all, wherever it went.
  const countStampedEmbeds = (node, isFormControl, unstamp) => {
    const seen = embedsIn(node, isFormControl);
    let held = 0;
    for (let i = 0; i < seen.length; i++) {
      if (seen[i][EMBED_MARK] !== true) continue;
      held++;
      if (unstamp) { try { delete seen[i][EMBED_MARK]; } catch (e) {} }
    }
    return held;
  };`;

/**
 * Page-side helpers, inlined into both probes: WHERE the characters went, and
 * what the field held before the clear.
 *
 * Both exist because "the target holds fewer characters than were dispatched" is
 * not the question the caller needs answered — "were the characters delivered to
 * the field I emptied?" is, and a count of what the field holds afterwards
 * answers it in neither direction:
 *
 *   - a page that moves focus away and back gets the count right at the ONE
 *     instant it is sampled. Measured on Chrome 151, 3/3: an autosuggest-shaped
 *     handler that focused a neighbour on the 2nd character and came back on its
 *     3rd left `aefgh` in the target and `bcd` in the neighbour, with focus
 *     restored — reported as a clean `{cleared: true}` replacement.
 *   - a page that reverts the field on blur (an editable data grid, a
 *     click-to-edit title, a controlled input rejecting a value) ends up holding
 *     MORE characters than were sent, so the count conjunct cannot fire either.
 *     Measured 3/3: the field held its exact pre-clear value, six characters were
 *     in the neighbour, and `cleared: true` was flatly false.
 *
 * So the target counts the insertions delivered to it — a `beforeinput` listener
 * armed when the element is parked, filtered to the `insert*` input types so the
 * clear's own `deleteContentBackward` is not one of them — and remembers the
 * value it is about to lose. A shortfall in DELIVERIES is what says the
 * characters went somewhere else; the value it holds afterwards is then only
 * asked whether it is wrong (short, or the pre-clear value back again).
 *
 * Both signals are needed, and each one alone is wrong:
 *
 *   - deliveries alone would fail a field that normalises what it receives
 *     (strips separators, trims, upper-cases): every character arrived, the value
 *     is merely shorter. That is the false-failure class the count conjunct was
 *     added to prevent.
 *   - the value alone is what M3 above defeats in both directions.
 *
 * A page whose own capture listener calls `stopPropagation` on `beforeinput`
 * hides the deliveries from this count — and is then saved by the second
 * signal, because the characters it swallowed the events for still landed in the
 * field. `-1` means the count could not be read at all (a page that refused the
 * property), and the caller falls back to the focus sample it used before.
 *
 * Arrival is not the same question as EFFECT, and a capture listener on
 * `beforeinput` can only answer the first. A field whose own handler cancels
 * every insertion in place — a controlled input rejecting the value, a validating
 * one — lets the event reach this listener first (that is what capture buys) and
 * then refuses it, so the arrival count reads full while nothing enters the
 * field. Measured on Chrome 148 against `<input value="old-value-seeded">` whose
 * `beforeinput` handler `preventDefault()`s every `insert*`, focus retained:
 * `{ clear: true, text: "abc" }` returned `{ typed: "abc", keys: 3,
 * cleared: true }` with the field EMPTY. Both signals agreed the wrong way — the
 * value was wrong, the arrivals were complete — so neither guard fired.
 *
 * So a second listener counts the `input` events, which Blink fires only once an
 * insertion HAS taken effect. Arrivals stay the focus evidence (unchanged by
 * whether the page then cancels); effects answer "did any of it land". The pair
 * is read in `platforms/chromium.ts`, which fires on the one corner where they
 * disagree completely: everything arrived, nothing took effect, the field is
 * empty. A page refusing SOME insertions is normalising, which is the
 * false-failure class this measurement exists to keep out.
 */
const deliveryFns = (marks: {
  count: string;
  listener: string;
  applied: string;
  appliedListener: string;
  wasValue: string;
}) => `
  const DELIVERY_COUNT = ${JSON.stringify(marks.count)};
  const DELIVERY_LISTENER = ${JSON.stringify(marks.listener)};
  const APPLIED_COUNT = ${JSON.stringify(marks.applied)};
  const APPLIED_LISTENER = ${JSON.stringify(marks.appliedListener)};
  const VALUE_BEFORE = ${JSON.stringify(marks.wasValue)};
  // BEFORE: start counting what arrives IN this element and what takes effect in
  // it, and remember what it holds. Armed on the element rather than on the
  // document so an insertion into a different field is not counted — that is the
  // whole measurement.
  const watchDeliveries = (el, isFormControl) => {
    try {
      el[DELIVERY_COUNT] = 0;
      el[APPLIED_COUNT] = 0;
      // The clear's own edit is a \`deleteContentBackward\`, so filtering to the
      // insertions keeps it out of either count without any bookkeeping.
      const isInsert = (ev) => String((ev && ev.inputType) || "").indexOf("insert") === 0;
      const onInsert = (ev) => {
        try {
          if (!isInsert(ev)) return;
          el[DELIVERY_COUNT] = (el[DELIVERY_COUNT] || 0) + 1;
        } catch (e) {}
      };
      const onApplied = (ev) => {
        try {
          if (!isInsert(ev)) return;
          el[APPLIED_COUNT] = (el[APPLIED_COUNT] || 0) + 1;
        } catch (e) {}
      };
      el[DELIVERY_LISTENER] = onInsert;
      el[APPLIED_LISTENER] = onApplied;
      // Capture on both, so a handler on the element itself cannot stop either
      // event reaching these first. \`input\` is not dispatched at all for an
      // insertion the page cancelled, which is exactly the difference being
      // measured.
      el.addEventListener("beforeinput", onInsert, true);
      el.addEventListener("input", onApplied, true);
      if (isFormControl) el[VALUE_BEFORE] = String(el.value || "");
    } catch (e) {}
  };
  // AFTER: how many insertions this element received, or -1 when that cannot be
  // read. Releases the listener on the way out, like every other per-call mark.
  const deliveriesTo = (el, release) => {
    let held = -1;
    try {
      if (typeof el[DELIVERY_COUNT] === "number") held = el[DELIVERY_COUNT];
      if (release) {
        if (el[DELIVERY_LISTENER]) el.removeEventListener("beforeinput", el[DELIVERY_LISTENER], true);
        delete el[DELIVERY_LISTENER];
        delete el[DELIVERY_COUNT];
      }
    } catch (e) {}
    return held;
  };
  // AFTER: how many of those insertions actually took effect, or -1 when that
  // cannot be read. Released alongside its sibling.
  const appliedTo = (el, release) => {
    let held = -1;
    try {
      if (typeof el[APPLIED_COUNT] === "number") held = el[APPLIED_COUNT];
      if (release) {
        if (el[APPLIED_LISTENER]) el.removeEventListener("input", el[APPLIED_LISTENER], true);
        delete el[APPLIED_LISTENER];
        delete el[APPLIED_COUNT];
      }
    } catch (e) {}
    return held;
  };
  // AFTER: the field holds exactly what it held before the clear — so whatever
  // else happened, it was not replaced. Only asked of a form control, whose
  // \`value\` is unambiguous; the revert-on-blur shape this catches is a form
  // control pattern.
  const heldValueAgain = (el, isFormControl, value, release) => {
    let same = false;
    try {
      const was = el[VALUE_BEFORE];
      same = isFormControl && typeof was === "string" && was !== "" && was === value;
      if (release) delete el[VALUE_BEFORE];
    } catch (e) {}
    return same;
  };`;

/**
 * Page-side helper: the text an editable holds that is the USER's, as opposed to
 * the editor's own empty state.
 *
 * `textContent` cannot tell the two apart, and an editor whose empty state is a
 * CHARACTER rather than an element then fails every clear that worked. Measured
 * in Chrome: `slate-react` renders a `ZeroWidthString` — a literal U+FEFF text
 * node — for every empty leaf whatever the configuration, so an emptied Slate
 * editable reads as 1 character and the clear is reported as "the field was NOT
 * emptied", with the requested `text` never typed and no retry able to help.
 * Reproduced 3/3 on the isolated leaf, and again on `&nbsp;` padding and on a
 * text placeholder.
 *
 * Two exclusions, mirroring how the element count treats the same content:
 *
 *   - text inside a `contenteditable="false"` subtree, which is how every editor
 *     marks an ATOMIC embed — a mention pill, an attachment chip, and Slate's
 *     placeholder, which sits INSIDE the editable. Whether such a node is
 *     residue or an empty-state marker is decided by `countEmbeds` + the
 *     before/after rule in `clearChromiumField`, not by its text: content that
 *     was there before and survived is still caught there, so nothing is lost by
 *     keeping it out of the character count as well.
 *   - zero-width characters, and a remainder that is only whitespace. Blink pads
 *     an empty line with `&nbsp;`, and the zero-width leaf above carries no
 *     meaning at all. The cost is a field whose surviving content is nothing but
 *     spaces, which reads as empty; the alternative is failing a whole class of
 *     editors on content the user cannot see.
 *   - text Blink does not RENDER, which it therefore neither selects nor
 *     deletes. `<style>`, `<script>` and a `display: none` a11y span are all
 *     ordinary rich-text-editor furniture, and counting their characters made a
 *     clear that emptied the editor report "the field was NOT emptied" with the
 *     requested `text` never typed — permanently, since no retry can remove
 *     content the chord cannot touch (measured on Chrome 148: `hello` plus a
 *     `display: none` span reported 18 surviving characters with `hello` gone,
 *     3/3; the same shapes with the hidden node removed cleared and typed
 *     correctly). `visibility` counts alongside `display` because Blink's
 *     selection skips that content too — measured on the same build, a
 *     `visibility: hidden` span survived the delete while a clipped
 *     `position: absolute` "screen-reader only" span, which IS rendered, was
 *     removed with the rest.
 */
const EDITABLE_TEXT_FN = `
  const editableText = (root) => {
    let out = "";
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) { out += child.nodeValue || ""; continue; }
        if (child.nodeType !== 1) continue;
        const ce = child.getAttribute ? child.getAttribute("contenteditable") : null;
        if (ce != null && String(ce).toLowerCase() === "false") continue;
        if (!isRendered(child)) continue;
        stack.push(child);
      }
    }
    return out;
  };
  const userText = (raw) => {
    const stripped = raw.replace(/[\\u200B-\\u200D\\uFEFF]/g, "");
    return stripped.trim() === "" ? "" : stripped;
  };`;

/**
 * Resolves the editable element that holds focus — across shadow roots and
 * same-origin iframes — and remembers it on `window` for the re-read.
 *
 * `activeElement` alone is both too weak and too strong as a focus test
 * (measured on Chrome 150): with focus inside an open shadow root the top-level
 * `activeElement` is the HOST element, and with focus inside a same-origin
 * iframe it is the `<iframe>` — yet a clear works correctly in both. Meanwhile a
 * focused `<button>` is a perfectly good `activeElement` and produces the same
 * useless document-wide selection as body focus. So the probe descends to the
 * innermost active element and then asks whether THAT one is a text field.
 *
 * Parking the element is what makes the verification unambiguous. Clearing a
 * field routinely moves focus — a page that blurs on empty, a node replaced by
 * a re-render, an app shortcut that jumps elsewhere — so re-reading
 * `activeElement` afterwards cannot tell "emptied, then focus moved" from
 * "never emptied, and focus moved". Re-reading the SAME element can.
 *
 * `activeElement`, `body` and `documentElement` are all read through the
 * `Document.prototype` accessors because the document's named getter is
 * `[LegacyOverrideBuiltIns]`: `<form name="activeElement">`, `<img name="body">`
 * and `<form name="documentElement">` each shadow the property they are named
 * after. Reading `doc.body` directly is how the two sentinels below get handed a
 * page-controlled element and hand the caller the wrong half of the refusal.
 * Same reasoning, and same technique, as the describe DOM walker, which guards
 * the identical read (`getDocBody = protoGetter(docProto, "body")`).
 *
 * Returns a JSON string rather than an object. Not a convention borrowed from
 * the sibling CDP helpers — `chromium-server/clipboard.ts` and
 * `chromium-server/storage.ts` both return objects through `returnByValue` — but
 * a local one: `evaluateJson`'s `typeof raw !== "string"` guard is what makes an
 * unreadable page fall to the best-effort branch, so the probes and that guard
 * have to agree. Returning an object here would put every clear on the
 * best-effort branch silently.
 */
// Exported for test/keyboard-clear-probe.test.ts, which evals it against a mock
// DOM: it runs inside the page, so the rest of the suite can only mock what it
// returns and every verdict it computes would otherwise rest on a manual
// browser session alone.
export const focusedEditableProbe = (handle: string) => `(() => {
  ${IS_RENDERED_FN}
  ${countEmbedsFns(pageMarks(handle).embed)}
  ${deliveryFns(pageMarks(handle))}
  // What a user pressing "select all" on THIS machine would send, so the page
  // sees the real chord. Read from the renderer, not the tool-server host — CDP
  // reaches remote renderers through a forwarded local port. Resolved OUTSIDE
  // the try so the catch below can still report it: the chord is dispatched even
  // when the page could not be read, and it should still be the native one.
  let mac = false;
  try { mac = /Mac|iPhone|iPad/i.test((navigator && navigator.platform) || ""); } catch (e) {}
  try {
    // Falls back to {} for anything that is not a usable prototype, not just for
    // an absent \`Document\`. A page that reassigns the global (\`window.Document =
    // {}\` — a polyfill, a sandbox shim) leaves \`Document.prototype\` undefined,
    // the descriptor read below throws, and the catch reports \`unknown\` — which
    // silently disables the whole verification and hands every clear on that page
    // the unverified best-effort branch. Measured on Chrome 130: the same page
    // that cancels its \`beforeinput\` refused the clear normally and returned
    // \`cleared: true\` with the field untouched once \`Document\` was shimmed (2/2).
    // With no accessor the reads below fall back to the plain property, which is
    // shadowable but right on every page that is not attacking us.
    const proto = typeof Document === "undefined" ? undefined : Document && Document.prototype;
    const docProto = proto && typeof proto === "object" ? proto : {};
    const protoGet = (name) => (Object.getOwnPropertyDescriptor(docProto, name) || {}).get;
    const activeOf = protoGet("activeElement");
    const bodyOf = protoGet("body");
    const rootOf = protoGet("documentElement");
    const active = (d) => (activeOf ? activeOf.call(d) : d.activeElement);
    const bodyOfDoc = (d) => (bodyOf ? bodyOf.call(d) : d.body);
    const rootOfDoc = (d) => (rootOf ? rootOf.call(d) : d.documentElement);
    let doc = document;
    let el = active(doc);
    // Bounded: a malformed page could otherwise cycle host → shadow → host.
    for (let hop = 0; hop < 32 && el; hop++) {
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "IFRAME" || tag === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        // Cross-origin: unreadable by design, so report "can't tell" rather
        // than a wrong verdict.
        if (!inner) return JSON.stringify({ verdict: "unknown", mac });
        doc = inner;
        el = active(inner);
        continue;
      }
      const shadow = el.shadowRoot;
      if (shadow && shadow.activeElement) { el = shadow.activeElement; continue; }
      break;
    }
    // Body / documentElement focus means "nothing is focused" — UNLESS the body
    // is itself the editing host. \`document.designMode = "on"\`, TinyMCE in its
    // default iframe mode and CKEditor 4 classic all put
    // \`<body contenteditable="true">\` inside the editor iframe, which is exactly
    // what the descent above exists to reach; Blink clears it correctly, so
    // refusing it would refuse a working clear and tell the caller to focus the
    // field it had already focused. The check is ordered before the sentinel
    // rather than left to the \`isContentEditable\` branch further down, which the
    // sentinel would otherwise shadow.
    if (!el) return JSON.stringify({ verdict: "none", mac });
    if ((el === bodyOfDoc(doc) || el === rootOfDoc(doc)) && el.isContentEditable !== true) {
      return JSON.stringify({ verdict: "none", mac });
    }
    const tag = (el.tagName || "").toUpperCase();
    // Both halves are page-controlled and unbounded, and this string is
    // interpolated verbatim into four agent-facing error messages — so it is
    // capped the way the TV blueprint caps device-supplied text, and narrowed to
    // the characters an identifier is actually made of. The cap alone bounds
    // LENGTH, not content, and ~55 characters of arbitrary page text is enough
    // to carry an instruction into the model's context. Spaces, quotes,
    // punctuation and newlines are what make that possible, and no real tag or
    // id needs them; an id made only of those degrades to the bare tag.
    const identChars = (value) => String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
    const safeId = identChars(el.id);
    const label = (identChars(tag) + (safeId ? "#" + safeId : "")).slice(0, 60);
    // Form controls first: \`isContentEditable\` is INHERITED, so an <input>
    // inside a contenteditable host reports true, and reading its textContent
    // (always "") would make every verification pass vacuously. A <textarea>
    // there is worse — textContent is its DEFAULT value and never tracks
    // \`value\`, so a clear that worked would look like a failure.
    const formControl = tag === "INPUT" || tag === "TEXTAREA";
    // Every <input> type that holds no user-editable text. The temporal types
    // are in here because the chord no-ops against them and leaves a selection
    // behind — measured on Chrome 150.
    const opaqueInput =
      /^(button|submit|reset|checkbox|radio|file|image|range|color|hidden|date|time|datetime-local|month|week)$/i;
    if (formControl) {
      if (tag === "INPUT" && opaqueInput.test(el.type || "text")) {
        return JSON.stringify({ verdict: "not-editable", label, mac });
      }
      if (el.readOnly === true) return JSON.stringify({ verdict: "read-only", label, mac });
      window[${JSON.stringify(handle)}] = el;
      watchDeliveries(el, true);
      return JSON.stringify({
        verdict: "editable", label, mac, parked: window[${JSON.stringify(handle)}] === el,
        // A password field is cleared like any other, but its LENGTH is
        // credential material and would otherwise reach the agent's context in
        // the failure message. Flag it so that message reports no count.
        secret: (el.type || "") === "password",
      });
    }
    // The rest of the natively focusable form controls, refused BY TAG for the
    // same inheritance reason and BEFORE the branch below — they hold no
    // editable text of their own, so falling through would park a widget the
    // chord never edits. Blink scopes select-all to the EDITING HOST, so a
    // <select> in a composer had the whole editor selected and deleted while the
    // parked node went with it and re-read as \`tracked: false\` — reported as a
    // clean \`cleared: true\` (measured on Chrome 148, 3/3, with an identical
    // <button> result). Outside an editing host both already land on the same
    // refusal at the end of this function, so only the inherited case changes.
    // Reachable by an ordinary tap: clicking a <select> inside a contenteditable
    // focuses the SELECT (a <button> yields focus to the host, but \`focus()\`
    // still lands on it).
    //
    // By tag, deliberately, rather than "editable only by INHERITANCE": the
    // narrower rule would rescue exactly one shape, a <button
    // contenteditable="true"> used as a text field (Blink does let you edit its
    // label — measured on Chrome 148), while still refusing a <select> that
    // carries the attribute itself, since a replaced widget's content is not
    // editable text either way. Refusing costs that one shape a working clear,
    // with a message that names the element and points at its own control;
    // guessing costs a destroyed editor reported as success.
    if (tag === "SELECT" || tag === "BUTTON") {
      return JSON.stringify({ verdict: "not-editable", label, mac });
    }
    if (el.isContentEditable === true) {
      // Measure the EDITING HOST, not whatever inside it holds focus. Blink
      // scopes select-all to the host, so an element that is editable only by
      // INHERITANCE — a focusable \`<span tabindex="0">\` inside a composer, a
      // toolbar chip, an empty inline widget — holds none of the content the
      // chord acts on, and measuring it made every verdict vacuous: measured on
      // Chrome 151, focus on such an empty span inside a host whose
      // \`beforeinput\` the page cancels reported "SPAN#btn was emptied … the
      // field is already empty" while the host still held every character, and
      // advised sending the rest of the request without \`clear\` — an append
      // into a full field, which is the outcome this parameter exists to
      // prevent. The host is also what the caller means by "the field", so the
      // label names it.
      //
      // The walk stops at the nearest element that declares the attribute
      // ITSELF, which is what Blink treats as the host: a nested editor inside
      // another editable is its own host, not the outer one. With nothing
      // declaring it (\`document.designMode\`) it climbs to that document's body
      // and stops there — see the BODY break below, which is what makes the
      // stop happen.
      let host = el;
      for (let up = 0; up < 32; up++) {
        const own = host.getAttribute ? host.getAttribute("contenteditable") : null;
        const declared = own == null ? null : String(own).toLowerCase();
        if (declared === "true" || declared === "" || declared === "plaintext-only") break;
        // The body is the top of the walk, and the test below cannot express
        // that on its own: under \`document.designMode\` NOTHING declares the
        // attribute and \`documentElement.isContentEditable\` is \`true\` as well,
        // so the walk took one more step and parked <html> — which
        // \`document.activeElement\` never reports (it falls back to <body>), so
        // the post-clear focus check read as focus lost EVERY time, whatever the
        // page did. Measured on Chrome 151 against a designMode document: the
        // whole document was emptied and \`{ clear, text }\` then raised
        // KEYBOARD_CLEAR_FOCUS_LOST naming HTML and blaming the page, with
        // \`activeElement\` BODY before and after. A bare \`{ clear: true }\` was
        // unaffected, so only the combined form — the form the parameter exists
        // for — hit it.
        if ((host.tagName || "").toUpperCase() === "BODY") break;
        const parent = host.parentElement;
        if (!parent || parent.isContentEditable !== true) break;
        host = parent;
      }
      const hostLabel =
        host === el
          ? label
          : (identChars((host.tagName || "").toUpperCase()) +
              (identChars(host.id) ? "#" + identChars(host.id) : "")).slice(0, 60);
      el = host;
      window[${JSON.stringify(handle)}] = el;
      watchDeliveries(el, false);
      // Stamps every embed it finds, so the verdict can tell content that
      // SURVIVED the clear from an empty-state placeholder the page inserts once
      // emptied — by identity, not by comparing counts. Called for that side
      // effect only: the after-probe reports the surviving stamps as \`residue\`,
      // so this count has no consumer and is not sent back.
      stampEmbeds(el, false);
      return JSON.stringify({
        verdict: "editable", label: hostLabel, mac, parked: window[${JSON.stringify(handle)}] === el,
      });
    }
    // Anything else is refused, INCLUDING a custom element whose shadow root is
    // closed and might hold an editable inside. That case is real, but a closed
    // root is indistinguishable from a plain focusable custom element holding
    // nothing editable (\`shadowRoot\` is null for both), and treating the whole
    // class as "can't tell" was measurably worse: the chord then no-ops, leaves
    // a document-wide selection, and the tool reports \`cleared: true\` with the
    // accompanying text unwritten — issue #449 exactly. Refusing costs a working
    // clear on closed-shadow components; guessing costs silent data corruption.
    return JSON.stringify({ verdict: "not-editable", label, mac });
  } catch (e) {
    return JSON.stringify({ verdict: "unknown", mac });
  }
})()`;

/**
 * Re-reads the element the probe parked. Releases it unless `keep` is set.
 *
 * `tracked: false` means the element is gone — the page navigated, or the probe
 * never parked one — which is not evidence either way. It is also what a page
 * that REPLACES the field on edit produces (the React remount pattern), and
 * there the blindness is total: nothing below runs, so a `{ clear, text }` whose
 * characters went nowhere still returns `cleared: true`. Measured on Chrome 150
 * against a field cloned on every `input` — 4/4 reported a clean replacement
 * with the text absent from the document. Detecting it would mean guessing which
 * node replaced the old one, and guessing wrong is the over-eager-guard failure
 * the focus checks below were narrowed to avoid, so this stays best-effort and
 * `cleared`'s own doc (../types.ts) says so.
 *
 * `focused` answers a second question the caller needs: does the element still
 * hold focus? Clearing routinely moves it — a field that blurs once empty, an
 * app that advances to the next input — and the characters of a combined
 * `{ clear, text }` are dispatched at whatever holds focus THEN, not at the
 * element that was emptied. `getRootNode().activeElement` is the right test for
 * that on every shape the probe can park: a shadow root and a (sub)document both
 * expose `activeElement`, and it is scoped to the tree the element actually
 * lives in.
 *
 * That test alone is not enough for one shape this file went out of its way to
 * support: a `<body contenteditable>` editing host (TinyMCE's default iframe
 * mode, CKEditor 4 classic, `document.designMode`). `Document.activeElement`
 * falls back to that document's `body` whenever nothing in the document holds
 * focus, so `active === el` is CONSTANT TRUE there — measured on Chrome 150,
 * with focus moved to a top-level input, the probe still reported
 * `focused: true` while `innerDoc.hasFocus()` had gone false, and a
 * `{ clear, text }` that emptied the editor and typed into the sidebar came back
 * as a clean replacement. So the containment chain is walked as well: at every
 * level the node must be its own root's `activeElement`, and the walk steps out
 * through `getRootNode()` — a shadow host, then the frame holding the document —
 * until it reaches the top or a container it cannot see past. `hasFocus()` is
 * deliberately NOT the test: it is false for the whole page whenever the browser
 * window is unfocused, which a CDP-driven browser routinely is, and that would
 * fail every clear.
 *
 * EVERY property the walk reads off a root — `activeElement`, `host`,
 * `defaultView` — goes through the prototype accessor, for the same reason
 * `focusedEditableProbe` does it: a document's named getter is
 * `[LegacyOverrideBuiltIns]`, so an element merely NAMED after one of them
 * shadows it. `<iframe name="activeElement">` makes that raw read return the
 * frame's `Window` and every successful clear report a lost focus; `<img
 * name="host">` makes the top-level document look like a shadow root and does
 * the same. Reading one of the three raw is enough to break the other two.
 *
 * `residue` counts the content a text measurement cannot see that was there
 * BEFORE and did not go away — the embeds the first probe stamped, still inside
 * the field. On a non-form target the value read is the element's text (see
 * `editableText`), so content carrying no text node — an `<img>`, a
 * `<video>`/`<canvas>`/`<svg>`, an `<hr>` — measures 0 and a clear that emptied
 * nothing reports success. Measured on Chrome 150: two contenteditables on one
 * page cancelling the same `beforeinput`, the one holding text refused (7/7) and
 * the one holding a single `<img>` returned `cleared: true` with the image
 * untouched. The tag list is embedded/replaced content only — never a structural
 * leftover like the `<br>`, `<div>` or `<p>` Blink and every rich-text editor
 * leave behind in a genuinely empty field — and a node the page inserted after
 * the clear carries no stamp, so it is not residue however many there are (see
 * `countEmbedsFns`).
 *
 * `keep: true` leaves the element parked so the caller can ask again after it
 * has typed — the reason `releaseTargetProbe` exists.
 */
// Exported for test/keyboard-clear-probe.test.ts — see focusedEditableProbe.
export const clearedTargetProbe = (handle: string, keep = false) => `(() => {
  ${IS_RENDERED_FN}
  ${countEmbedsFns(pageMarks(handle).embed)}
  ${deliveryFns(pageMarks(handle))}
  ${EDITABLE_TEXT_FN}
  try {
    const el = window[${JSON.stringify(handle)}];
    ${keep ? "" : `delete window[${JSON.stringify(handle)}];`}
    if (!el) return JSON.stringify({ tracked: false });
    let focused = false;
    try {
      // The accessor a root declares for \`name\`, found by walking the prototype
      // CHAIN rather than the immediate prototype: on an HTML document the own
      // prototype is HTMLDocument.prototype while \`activeElement\` and
      // \`defaultView\` are declared on Document.prototype above it, so a
      // one-level lookup finds nothing and falls back to the shadowed read.
      const accessorOf = (node, name) => {
        for (let proto = node && Object.getPrototypeOf(node); proto; ) {
          const d = Object.getOwnPropertyDescriptor(proto, name);
          if (d && d.get) return d.get;
          proto = Object.getPrototypeOf(proto);
        }
        return undefined;
      };
      const activeIn = (node) => {
        const activeOf = accessorOf(node, "activeElement");
        return node ? (activeOf ? activeOf.call(node) : node.activeElement) : null;
      };
      // No raw fallback: a shadow root ALWAYS declares \`host\` on
      // ShadowRoot.prototype, so "no accessor" means "not a shadow root", while
      // \`host\` is not a Document property at all — \`document.host\` is PURELY the
      // named getter, and any element named "host" would otherwise make the
      // top-level document look like a shadow root.
      const hostOf = (root) => {
        const get = accessorOf(root, "host");
        return get ? get.call(root) : null;
      };
      // \`defaultView\` IS on Document.prototype, so the accessor is always found
      // for a real document and the fallback only serves a root with nothing to
      // shadow (where it reads undefined anyway).
      const viewOf = (root) => {
        const get = accessorOf(root, "defaultView");
        return get ? get.call(root) : root.defaultView;
      };
      // Climb out of every tree the element sits in, requiring at each level
      // that the node is its OWN root's \`activeElement\`, then stepping up to
      // whatever contains that root — a shadow host, or the frame holding the
      // document. The local read alone is not enough: a body editing host is its
      // document's \`activeElement\` even when focus left that document entirely.
      //
      // Stepping up through \`getRootNode()\` rather than \`ownerDocument\` is what
      // makes the shadow case right. \`ownerDocument\` is NOT retargeted, so an
      // \`<iframe>\` inside an open shadow root reports the TOP document, while
      // that document's \`activeElement\` retargets to the shadow HOST — the frame
      // and the active element then never match, and a field that never lost
      // focus is reported as blurred.
      let node = el;
      focused = true;
      for (let hop = 0; hop < 32; hop++) {
        const root = node.getRootNode ? node.getRootNode() : null;
        if (activeIn(root) !== node) { focused = false; break; }
        // A shadow root: the next question is whether its host holds focus.
        const host = hostOf(root);
        if (host) { node = host; continue; }
        // A document: step out to the frame containing it, if any. A
        // cross-origin container reports \`frameElement\` as null (and a document
        // with no browsing context has no \`defaultView\`), which is "can't tell"
        // — stop and keep the verdict the levels below already established
        // rather than inventing a loss. The \`try\` is belt and braces for an
        // engine that throws instead.
        let frame = null;
        try { const view = viewOf(root); frame = view && view.frameElement; } catch (e) { break; }
        if (!frame) break;
        node = frame;
      }
    } catch (e) { focused = false; }
    // A page that replaces the field on edit (the React remount pattern) leaves
    // this node detached and holding its OLD value forever, while the live field
    // really was cleared. A stale read there is a false failure, so a detached
    // node counts as "cannot tell" rather than as residue.
    if (el.isConnected === false) return JSON.stringify({ tracked: false });
    const tag = (el.tagName || "").toUpperCase();
    const form = tag === "INPUT" || tag === "TEXTAREA";
    const bad = form && !!(el.validity && el.validity.badInput);
    // A form control's \`value\` is exactly what the user has, with no empty state
    // of its own to discount — see \`editableText\` for why the other branch
    // cannot use its raw text.
    const value = form ? (el.value || "") : userText(editableText(el));
    // Un-stamp on the release pass only, so the stamps outlive the verdict read
    // exactly as long as the parked element itself does.
    const residue = countStampedEmbeds(el, form, ${keep ? "false" : "true"});
    // \`maxLength\` reflects as -1 when the attribute is absent, so a negative
    // limit means "no limit" rather than "holds nothing".
    const limit = form && typeof el.maxLength === "number" ? el.maxLength : -1;
    return JSON.stringify({
      tracked: true,
      focused,
      residue,
      secret: (el.type || "") === "password",
      length: bad ? Math.max(1, value.length) : value.length,
      // A boolean, not the limit: the caller only needs to know whether the
      // field's own cap explains a short value, and a password field's capacity
      // is one more thing about a credential not to echo back.
      full: limit >= 0 && value.length >= limit,
      // How many characters were delivered INTO this element, how many of those
      // actually took effect in it, and whether it ended up holding the very
      // value the clear removed — see \`deliveryFns\`.
      delivered: deliveriesTo(el, ${keep ? "false" : "true"}),
      applied: appliedTo(el, ${keep ? "false" : "true"}),
      reverted: heldValueAgain(el, form, value, ${keep ? "false" : "true"}),
    });
  } catch (e) {
    return JSON.stringify({ tracked: false });
  }
})()`;

export interface FocusedEditable {
  verdict: "editable" | "not-editable" | "read-only" | "none" | "unknown";
  label?: string;
  mac?: boolean;
  /** True for a password input, whose length must not be echoed back. */
  secret?: boolean;
  /** False when the page refused the slot assignment — then nothing was parked. */
  parked?: boolean;
}

export interface ClearedTarget {
  tracked: boolean;
  /** Whether the cleared element still holds focus in its own root. */
  focused?: boolean;
  secret?: boolean;
  length?: number;
  /**
   * Embedded content (an image, a video, an `<hr>`) `textContent` cannot see
   * that was already there BEFORE the clear and is still in the field — the
   * stamped ones, not a fresh count. See `countEmbedsFns`.
   */
  residue?: number;
  /**
   * The field is at its own `maxlength`, so it could not hold another character
   * whatever else happened — which is what makes a value shorter than the
   * request its own explanation rather than evidence of a split. See the guard
   * in `platforms/chromium.ts`.
   */
  full?: boolean;
  /**
   * Characters delivered INTO this element since it was parked, or -1 when the
   * count could not be read. This is the provenance question — "did the
   * characters reach the field I emptied?" — which what the field HOLDS
   * afterwards answers in neither direction. See `deliveryFns`.
   */
  delivered?: number;
  /**
   * How many of those deliveries actually TOOK EFFECT in this element, or -1 when
   * the count could not be read. `delivered` cannot answer that: a page that
   * cancels an insertion in place still lets the `beforeinput` reach the capture
   * listener, so a field that refuses everything reads as fully delivered. Blink
   * fires `input` only for an insertion it applied. See `deliveryFns`.
   */
  applied?: number;
  /**
   * The field holds the very value the clear removed, so it was not replaced
   * however many characters were dispatched at it. See `deliveryFns`.
   */
  reverted?: boolean;
}

/**
 * What {@link clearChromiumField} observed, for the caller that types next.
 *
 * `keptFocus: undefined` means the page could not be read, so nothing is known —
 * the same best-effort branch the emptiness check falls to.
 */
interface ClearOutcome {
  keptFocus?: boolean;
  /** The element label the probe reported, for the caller's error message. */
  label?: string;
  /**
   * The field was a password input when the clear read it — so the caller's own
   * failure message must withhold counts too.
   *
   * Carried here because the two reads can disagree: a show/hide control that
   * switches the field to `type="text"` while the characters go out leaves the
   * LATER read reporting a plain box, and the caller only ever sees that one.
   * Without this, "it was a password field when we cleared it" was dropped
   * between the two messages that apply the same rule.
   */
  secret?: boolean;
}

/**
 * How long to let the page react before measuring the cleared field.
 *
 * A module constant, NOT the caller's `delayMs`. `delayMs` is documented as
 * typing cadence ("Delay in ms between key presses"), and spending it here made
 * it the width of a correctness window as well: measured on Chrome 150 against a
 * field that moves focus 5ms after becoming empty, `{ clear, text: "hi" }` at
 * the default 50 refused cleanly and left the page untouched 4/4, while the same
 * call with `delayMs: 0` wrote text outside the target field in 8 of 11 runs —
 * splitting it across two fields, or landing the whole value in the neighbour.
 * `delayMs: 0` is what this PR's own Chromium tests pass throughout.
 *
 * 50ms is the `delayMs` default, and the window the settle was measured at
 * (5/5 catching a blur at 10-40ms). A caller asking for a LONGER cadence still
 * gets it — a slow page is the one case where more settle can only help — so the
 * value used is the larger of the two.
 */
const CLEAR_SETTLE_MS = 50;

/**
 * Re-read the parked element's focus and release it, in one round trip.
 *
 * The caller uses this both to ask "did focus survive the typing?" and simply to
 * let the element go, so the handle is never left pinning a detached subtree.
 */
export async function releaseParkedTarget(
  api: ChromiumCdpApi,
  handle: string
): Promise<ClearedTarget | undefined> {
  return evaluateJson<ClearedTarget>(api, clearedTargetProbe(handle, false));
}

async function evaluateJson<T>(api: ChromiumCdpApi, expression: string): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = await api.evaluate(expression, { returnByValue: true });
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Never throws: an unreadable page is reported as `unknown`, not as a failure. */
async function readFocusedEditable(api: ChromiumCdpApi, handle: string): Promise<FocusedEditable> {
  const read = await evaluateJson<FocusedEditable>(api, focusedEditableProbe(handle));
  if (read) return read;
  // `evaluate` itself failed, so the renderer never got to report its platform.
  // The chord is still dispatched on this path, so it should still be the native
  // one; the host is the best remaining proxy, since a Chromium target is found
  // by probing CDP ports on this machine. (The probe's own catch carries `mac`,
  // so this covers only the case where the call never returned a value at all.)
  return { verdict: "unknown", mac: process.platform === "darwin" };
}

// CDP's `Input.dispatchKeyEvent` modifier bitmask: 2 = Ctrl, 4 = Meta.
const CDP_MODIFIER_CTRL = 2;
const CDP_MODIFIER_META = 4;

/**
 * Empty the focused field. Resolves when the field was observed empty
 * afterwards, or when the page could not be read; throws otherwise.
 *
 * The caller owns `handle` and MUST release it — `releaseParkedTarget`, from a
 * `finally` — however this returns. It is deliberately still parked on the way
 * out, so focus can be asked about again once the caller has finished typing,
 * and the slot is the sole retainer of that element (confirmed with a WeakRef +
 * forced GC). A per-call slot name means a leaked one is never overwritten by
 * the next clear, so a caller that skips the release leaks one element per call.
 *
 * The editing itself rides `commands` on the `rawKeyDown` rather than being
 * driven by the modifier — see the `commands` doc on `KeyEventArgs` — but the
 * modifier is set as well, so that what the page receives is a select-all chord
 * and not a bare `a` keypress. Both editing commands ride the same event so
 * Blink applies them in order, which fires `oninput` once (`deleteContentBackward`)
 * and leaves a controlled/React input correctly updated.
 *
 * `secretText` says the value the caller is about to type came from a
 * `{{secret:…}}` placeholder, which makes the RESIDUE's length credential
 * material too: the box a credential is typed into is usually the box that
 * already holds one, and the page-side `secret` flag is `type === "password"`
 * alone — false for an API-key field, a TOTP input, or a password field a
 * show/hide control has switched to `type="text"`. `redactSecretsFromError`
 * substitutes the value string and cannot redact a count, so the count has to be
 * withheld here. Same reasoning, and the same three shapes, as the split-across-
 * fields guard in `platforms/chromium.ts`.
 *
 * Neither form of the key is universally safe from the page, which is why the
 * result is verified rather than assumed: unmodified, any shortcut bound to a
 * bare `a` fires and can cancel the edit; modified, an app that binds the
 * platform select-all chord can cancel it instead. The modifier is the one a
 * real user would send, so it is what an app is entitled to intercept — and if
 * it does, the check below reports the clear as the failure it is instead of
 * letting a following `text` append to the surviving value.
 */
export async function clearChromiumField(
  api: ChromiumCdpApi,
  handle: string,
  delayMs: number,
  secretText = false
): Promise<ClearOutcome> {
  const settleMs = Math.max(delayMs, CLEAR_SETTLE_MS);
  const before = await readFocusedEditable(api, handle);
  if (before.verdict === "none" || before.verdict === "not-editable") {
    // Well-formed request against a page that cannot serve it — a 400, the same
    // treatment the un-typeable-character rejections get, and thrown before any
    // dispatch so no document-wide selection is left behind.
    //
    // The two halves get different advice: with nothing focused, tapping the
    // field fixes it; with a non-text element focused (a <select>, a date
    // picker, a custom element) tapping again will not, and saying so avoids
    // sending the caller into a retry loop.
    throw new InvalidToolInputError(
      before.label
        ? `keyboard clear: the focused element ${before.label} is not a text field, so there ` +
            `is nothing to empty. Blink's select-all is not scoped to a field, so clearing here ` +
            `would select the page instead. Focus a text input, or use the element's own control.`
        : `keyboard clear: no editable element has focus. Blink's select-all is not scoped to ` +
            `a field, so clearing here would select the page instead of emptying an input. Tap ` +
            `the field first, then clear.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS,
        failure_stage: "keyboard_clear_focus_chromium",
        error_kind: "unsupported",
      }
    );
  }
  if (before.verdict === "read-only") {
    throw new InvalidToolInputError(
      `keyboard clear: the focused element ${before.label ?? ""} is read-only, so its ` +
        `contents cannot be deleted.`,
      {
        // Its own code, not NO_EDITABLE_FOCUS: the two remedies are opposite.
        // "Nothing editable has focus" is fixed by tapping the field; a
        // `readonly` field stays unclearable however often it is tapped, and
        // `failure_stage` — the only thing that told them apart — is not
        // serialized onto the wire (`http.ts` sends `error_code` and
        // `error_kind` only), so a client keying on the signal could not.
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_READ_ONLY,
        failure_stage: "keyboard_clear_readonly_chromium",
        error_kind: "unsupported",
      }
    );
  }

  const modifiers = before.mac ? CDP_MODIFIER_META : CDP_MODIFIER_CTRL;
  const selectAllKey = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers };
  // The read-back is the last thing before the verdict below, so nothing can
  // slip between the settle and the measurement. On the THROW path it runs and
  // its value is discarded — the exception propagates before anything reads
  // `after`, and the slot is let go by the caller's own `finally`, not here.
  // It does NOT release the slot — see `keep` below — and nothing in here does:
  // releasing is the caller's, because the parked element has to outlive the
  // typing that follows.
  let after: ClearedTarget | undefined;
  try {
    await api.dispatchKeyEvent({
      type: "rawKeyDown",
      ...selectAllKey,
      commands: ["selectAll", "deleteBackward"],
    });
    await api.dispatchKeyEvent({ type: "keyUp", ...selectAllKey });
    // Settle BEFORE measuring, not after. A page reacts to becoming empty in a
    // later task — a field that blurs itself, one that advances to the next
    // input, a re-render — so a read taken microseconds after the key event
    // sees the state the page has not finished leaving. Measured on Chrome 150:
    // the probe landed 2-24ms after the dispatch while typing started `delayMs`
    // later, and a blur scheduled anywhere inside that gap was invisible to the
    // check that exists to catch it (4/8 at a 30ms blur, 5/5 at 10-40ms).
    // Sleeping here instead of in the caller makes this read the LAST thing
    // before the first character goes out.
    await sleep(settleMs);
  } finally {
    // `keep`, so the caller can ask the same element about focus again once it
    // has finished typing — a blur can also land mid-loop, which no single
    // sample before the loop can see.
    after = await evaluateJson<ClearedTarget>(api, clearedTargetProbe(handle, true));
  }

  // `unknown` before means the page was unreadable, so no element was parked and
  // there is nothing to verify against; `parked: false` means the assignment
  // itself did not take (a page can pre-define the slot non-writable). Either
  // way, stay best-effort rather than inventing a failure.
  // `secret` travels on every return: the caller applies the same
  // withhold-the-count rule to its own message, and the LATER read is the only
  // one it can see (see `ClearOutcome.secret`).
  const secret = before.secret === true;
  if (before.verdict !== "editable" || before.parked === false)
    return { label: before.label, secret };

  // The re-read measures the element the probe parked, NOT whatever holds focus
  // now. Clearing routinely moves focus (a page that blurs on empty, a
  // re-render, an app shortcut), so `activeElement` afterwards cannot tell
  // "emptied, then focus moved" from "never emptied, and focus moved" — and the
  // second is exactly what an app cancelling the chord produces.
  if (!after?.tracked) return { label: before.label, secret };
  const remaining = after.length ?? 0;
  // Embedded content counts as residue only when it is the SAME content that was
  // there before — the probe stamps each embed and this counts the stamps still
  // in the field, so an editor that swaps in a placeholder node once it becomes
  // empty (an icon-only `<span contenteditable="false">`, the common composer
  // pattern) is not mistaken for the `<img>` whose delete the page cancelled.
  // Comparing counts cannot separate those two: both go 1 → 1. See
  // `countEmbedsFns`.
  const residualNodes = after.residue ?? 0;
  if (remaining === 0 && residualNodes === 0) {
    return {
      keptFocus: after.focused === true,
      label: before.label,
      secret: secret || after.secret === true,
    };
  }

  const held =
    after.secret || secret || secretText
      ? "its contents"
      : remaining > 0
        ? `${remaining} character(s)`
        : // Embedded content only: no text survived, but an image / video /
          // `<hr>` did, and `textContent` cannot see it.
          `${residualNodes} embedded element(s) (an image, a video or similar)`;
  throw new FailureError(
    `keyboard clear: ${before.label ?? "the field"} still holds ${held} ` +
      `after the select-all + delete. The page most likely cancelled the key or the ` +
      `\`beforeinput\` (a rich-text editor, or an app that binds the select-all chord, does ` +
      `this), or this Chromium build ignores CDP editing commands. The field was NOT ` +
      `emptied — do not treat a following \`text\` as a replacement.`,
    {
      error_code: FAILURE_CODES.KEYBOARD_CLEAR_INEFFECTIVE,
      failure_stage: "keyboard_clear_verify_chromium",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

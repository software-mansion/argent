import { describe, expect, it } from "vitest";
import {
  CLEAR_FOCUSED_EDITABLE_SCRIPT,
  CONTENT_SIGNATURE_JS,
} from "../src/tools/keyboard/platforms/chromium";

/**
 * `CLEAR_FOCUSED_EDITABLE_SCRIPT` is an IIFE injected via Runtime.evaluate. It
 * decides *inside the renderer* whether anything editable holds keyboard focus,
 * and deletes only then. Every other test can mock the CDP answer, so that
 * decision — the part that keeps a clear aimed at nothing from wiping whatever
 * the page focuses by default, and keeps a readonly field untouched — is
 * observable only by evaluating the real source. Mirrors
 * describe-chromium-script.test.ts, which evals `DESCRIBE_DOM_SCRIPT` the same
 * way.
 *
 * The mock implements the whole DOM surface the script reads: `activeElement`,
 * `execCommand`, and per element `tagName` / `type` / `disabled` / `readOnly` /
 * `isContentEditable` / `shadowRoot`.
 */

interface Outcome {
  cleared?: boolean;
  focus?: string | null;
  reason?: string;
  detail?: string;
}

// Chrome's own answers, measured on 151.0.7922.174 by evaluating `selectAll`
// then `delete` against one live element per input type. `delete` is true for
// every element that ends up empty — including one that was ALREADY empty,
// where `selectAll` is false — and false for exactly the five date/time types,
// which keep their value. A mock whose `execCommand` always returns true cannot
// express the case the script exists to catch, so this table is what the
// refusal tests drive.
const DATE_TIME_TYPES = ["date", "datetime-local", "month", "week", "time"];

/**
 * Where `run` collects what the script asked the renderer to do — both
 * `execCommand` names and `.select()` on a text control, in call order. Element
 * mocks are built before `run` has its local array, so they push through here.
 */
let commandLog: string[] = [];

/**
 * One element as the script sees it. `tagName` is uppercase, as in a real DOM.
 *
 * `childNodes` defaults to one node — "an ordinary element with light content".
 * The script reads it to spot a host hiding a CLOSED shadow root, whose light
 * subtree is empty; pass `childNodes: []` for that shape.
 *
 * `select` is the text control's own select-all: the script calls it instead of
 * `execCommand("selectAll")` for an <input>/<textarea>, because that command
 * acts on the DOCUMENT's selection and a page selection anchored elsewhere then
 * hijacks it.
 */
function el(tagName: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagName,
    childNodes: [{}],
    select() {
      commandLog.push("select");
    },
    // The page's own selection is anchored OUTSIDE this element unless a case
    // says otherwise — the copy-to-clipboard shape, and the reason a
    // contenteditable clear now moves the selection into its host before the
    // select-all. Pass `contains: () => true` for a case where it is already
    // inside.
    contains: () => false,
    ...props,
  };
}

const textInput = () => el("INPUT", { type: "text" });

/**
 * Eval the script with `document.activeElement` pointing at `active`, and report
 * both its return value and the execCommand calls it made. Indirect eval so the
 * IIFE runs in global scope and reads the injected global, as it does in a page.
 */
function run(
  active: unknown,
  /**
   * What the renderer's `execCommand` answers, per command name — the PAGE-wide
   * fallback. Chrome's own answer depends on the ELEMENT (a date input refuses
   * the delete, a text input accepts it), so an element can override it with
   * `deleteAnswer` / `selectAllAnswer`; a mock that answered by command name
   * alone could not express the case the refusal exists for, and would pass a
   * script that ignored the focused element entirely.
   */
  answers: Record<string, boolean> = {},
  /**
   * Extra `document` members. `body` / `documentElement` let a test point
   * `activeElement` AT the document's own editing host (designMode /
   * <body contenteditable>), which is the one refusal decided by identity.
   * `execCommand` may also be replaced with a thrower.
   */
  documentExtras: Record<string, unknown> = {}
): {
  outcome: Outcome;
  commands: string[];
  selectionsDropped: number;
  /** The host ranges the script built to scope its select-all. */
  hostRanges: Array<Record<string, unknown>>;
  /** What the page's selection holds when the script returns. */
  selection: () => unknown[];
  /** What the script parked on the page for the read-back to compare against. */
  parked: { el?: unknown; before?: unknown } | undefined;
} {
  const commands: string[] = [];
  commandLog = commands;
  const dropped = { count: 0 };
  // The page's own selection, as one opaque range. The script must clone it
  // before it selects anything and put it back on every refusal — a highlighted
  // code block is visible page state the next screenshot-diff registers.
  const pageRange = { id: "page-selection" };
  let ranges: unknown[] = [pageRange];
  const hostRanges: Array<Record<string, unknown>> = [];
  const g = globalThis as Record<string, unknown>;
  const had = Object.hasOwn(g, "document");
  const saved = g.document;
  // The page's `window`, which the script parks its record on. Left undefined,
  // that assignment threw and the script's own try swallowed it — so `contentOf`
  // ran in every test here and was observed by none, and the record the
  // read-back is built to consume existed in no test at all.
  const hadWindow = Object.hasOwn(g, "window");
  const savedWindow = g.window;
  const win: Record<string, unknown> = {};
  g.window = win;
  // The element the script is about to act on, found by the same shadow descent
  // it does — so a per-element answer follows focus into a shadow root.
  const focusedElement = (): Record<string, unknown> | undefined => {
    let node = active as Record<string, unknown> | undefined;
    while (node && node.shadowRoot) {
      const inner = (node.shadowRoot as Record<string, unknown>).activeElement;
      if (!inner) break;
      node = inner as Record<string, unknown>;
    }
    return node;
  };
  g.document = {
    activeElement: active,
    execCommand(name: string) {
      commands.push(name);
      // Chrome's `selectAll` REPLACES the page's own selection — on a field it
      // then refuses, with a range covering the whole document. The mock has to
      // do the same, or "the page's selection was put back" is an assertion on
      // ranges nothing ever disturbed, and it passes with the restore deleted.
      if (name === "selectAll") ranges = [{ id: "select-all" }];
      const perElement = focusedElement()?.[`${name}Answer`];
      if (typeof perElement === "boolean") return perElement;
      return answers[name] ?? true;
    },
    // A refusal reached AFTER `selectAll` has to undo it: on a field Chrome then
    // refuses, `selectAll` selects the whole document, and that highlight would
    // otherwise reach the next screenshot.
    getSelection: () => ({
      get rangeCount() {
        return ranges.length;
      },
      getRangeAt: (i: number) => ({
        cloneRange: () => ranges[i],
        // Where the page's selection sits, which the script tests against the
        // focused editable's own `contains`.
        commonAncestorContainer: ranges[i],
      }),
      addRange(r: unknown) {
        ranges.push(r);
      },
      removeAllRanges() {
        dropped.count++;
        ranges = [];
      },
    }),
    // The script builds one of these to put the selection inside the focused
    // editing host, so `selectAll` has an editable root to scope to.
    createRange: () => {
      const range = {
        id: "host-contents",
        node: undefined as unknown,
        selectNodeContents(node: unknown) {
          range.node = node;
        },
      };
      hostRanges.push(range);
      return range;
    },
    ...documentExtras,
  };
  try {
    const outcome = (0, eval)(CLEAR_FOCUSED_EDITABLE_SCRIPT) as Outcome;
    return {
      outcome,
      commands,
      selectionsDropped: dropped.count,
      /** The host ranges the script built to scope its select-all. */
      hostRanges,
      selection: () => ranges,
      parked: win.__argentClearTarget as { el?: unknown; before?: unknown } | undefined,
    };
  } finally {
    if (had) g.document = saved;
    else delete g.document;
    if (hadWindow) g.window = savedWindow;
    else delete g.window;
  }
}

/**
 * The signature the script parks, from the SAME source the script interpolates —
 * so this file cannot drift from it the way a hand-copied helper would.
 */
const signatureOf = (0, eval)(`(node) => { ${CONTENT_SIGNATURE_JS} return contentOf(node); }`) as (
  node: unknown
) => string | null;

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — what it agrees to clear", () => {
  // Select-all then `delete`, in that order: `delete` on its own removes one
  // character (or nothing, with a collapsed caret at the end), which is exactly
  // the silent near-no-op the whole design is built to avoid. Pinning the pair
  // and the order also records that neither is a keyboard event — the script
  // delivers no keydown, so a page shortcut bound to "a" cannot cancel it.
  //
  // WHICH select-all is per element kind, and that is load-bearing. A text
  // control keeps its own selection and `.select()` acts on THAT;
  // `execCommand("selectAll")` acts on the document's, which a page selection
  // anchored elsewhere hijacks — measured on Chrome 151 as an ordinary <input>
  // that could not be cleared at all. A contenteditable has no separate
  // selection to hijack, and `selectAll` is also what reaches into an open
  // shadow root, so it keeps that one.
  it.each([
    ["a text input", () => el("INPUT", { type: "text" }), "input type=text", "select"],
    ["an input with no explicit type", () => el("INPUT", {}), "input type=text", "select"],
    ["a password input", () => el("INPUT", { type: "password" }), "input type=password", "select"],
    ["a number input", () => el("INPUT", { type: "number" }), "input type=number", "select"],
    ["a search input", () => el("INPUT", { type: "search" }), "input type=search", "select"],
    ["an email input", () => el("INPUT", { type: "email" }), "input type=email", "select"],
    ["a textarea", () => el("TEXTAREA", {}), "textarea", "select"],
    ["a contenteditable element", () => el("DIV", { isContentEditable: true }), "div", "selectAll"],
  ])("clears %s with %s + delete", (_label, make, focus, selectAll) => {
    const { outcome, commands } = run(make());
    // `focus` rides along on the success too: the backend quotes it in the
    // read-back's own refusal.
    expect(outcome).toEqual({ cleared: true, focus });
    expect(commands).toEqual([selectAll, "delete"]);
  });

  // The refusals. Each one must ALSO leave the page untouched: the script
  // returns before it selects anything, so a refused clear cannot leave a
  // page-wide selection behind for the user to find.
  //
  // `reason` is per-case rather than one constant, because the backend picks the
  // ERROR CODE and the repair from it, and the two repairs are opposites.
  // "not-editable" means focus is on the wrong element, so tapping the field is
  // the fix; every other reason here means the focused element is the right one
  // and cannot be cleared, where tapping it again loops an agent forever.
  it.each([
    [
      "a readonly input",
      () => el("INPUT", { type: "text", readOnly: true }),
      "input type=text",
      "readonly",
    ],
    [
      "a disabled input",
      () => el("INPUT", { type: "text", disabled: true }),
      "input type=text",
      "disabled",
    ],
    ["a disabled textarea", () => el("TEXTAREA", { disabled: true }), "textarea", "disabled"],
    ["a readonly textarea", () => el("TEXTAREA", { readOnly: true }), "textarea", "readonly"],
    [
      "a checkbox",
      () => el("INPUT", { type: "checkbox" }),
      "input type=checkbox",
      "not-a-text-field",
    ],
    ["a radio", () => el("INPUT", { type: "radio" }), "input type=radio", "not-a-text-field"],
    ["a file input", () => el("INPUT", { type: "file" }), "input type=file", "not-a-text-field"],
    [
      "a submit button",
      () => el("INPUT", { type: "submit" }),
      "input type=submit",
      "not-a-text-field",
    ],
    [
      "a range slider",
      () => el("INPUT", { type: "range" }),
      "input type=range",
      "not-a-text-field",
    ],
    [
      "a colour picker",
      () => el("INPUT", { type: "color" }),
      "input type=color",
      "not-a-text-field",
    ],
    ["a select", () => el("SELECT", {}), "select", "not-a-text-field"],
    ["a plain button", () => el("BUTTON", {}), "button", "not-editable"],
    ["a plain div", () => el("DIV", { isContentEditable: false }), "div", "not-editable"],
    ["the body (nothing focused)", () => el("BODY", {}), "body", "not-editable"],
    // An <iframe> is decided by TAG, before the opaque-host tests: a real one
    // has no light children (`childNodes.length === 0`, measured on Chrome 152)
    // and would otherwise be classified `host-opaque` and told to "tap the field
    // inside it" — which is what the caller already did, one document down.
    ["an iframe", () => el("IFRAME", { childNodes: [] }), "iframe", "iframe"],
    ["an iframe with light children", () => el("IFRAME", {}), "iframe", "iframe"],
  ])("refuses %s, naming what holds focus, and deletes nothing", (_label, make, focus, reason) => {
    const { outcome, commands } = run(make());
    expect(outcome).toEqual({ cleared: false, focus, reason });
    expect(commands).toEqual([]);
  });

  it("blames the field kind before readonly, so a readonly checkbox is not a readonly field", () => {
    // `readonly` has no effect on a checkbox at all; reporting it would send the
    // caller after a state the app cannot change into a clearable one.
    expect(run(el("INPUT", { type: "checkbox", readOnly: true })).outcome.reason).toBe(
      "not-a-text-field"
    );
  });

  it("reports a null activeElement as no focus at all, not as an element", () => {
    // A detached / not-yet-loaded document answers `null` here. `focus: null`
    // is what makes the backend say "no element has keyboard focus" rather than
    // "<null>" — a distinction the caller acts on: one means tap the field, the
    // other means the page is not ready.
    const { outcome, commands } = run(null);
    expect(outcome).toEqual({ cleared: false, focus: null, reason: "not-editable" });
    expect(commands).toEqual([]);
  });

  it("matches the input type case-insensitively", () => {
    // Not a shape the real DOM produces: `HTMLInputElement.type` reflects
    // "limited to only known values", so a live `<input TYPE="CHECKBOX">` reads
    // back as the lowercase "checkbox". The fold is for the OTHER readers of
    // this script — a framework-rendered tree, a shadow-DOM shim, a test double
    // — where `.type` is whatever the author wrote. Dropping it would treat
    // that checkbox as a text field and "clear" it.
    expect(run(el("INPUT", { type: "CHECKBOX" })).outcome).toEqual({
      cleared: false,
      focus: "input type=checkbox",
      reason: "not-a-text-field",
    });
  });

  it("only refuses the non-text input types, not every unusual one", () => {
    // Positive control for the refusal list: it is a denylist, so a type nobody
    // enumerated (`tel`, `url`, a future one) must still clear. An allowlist
    // would silently refuse those and is the tempting rewrite. In a real DOM an
    // unrecognised type reflects as "text" and would clear for that reason
    // instead; the denylist is what makes both readings agree.
    for (const type of ["tel", "url", "search", "email"]) {
      expect(run(el("INPUT", { type })).outcome, `refused type="${type}"`).toEqual({
        cleared: true,
        focus: `input type=${type}`,
      });
    }
  });

  it("names the focused input's type, so a refusal says which field it hit", () => {
    // `<input>` alone is not a diagnosis: "it is on <input>" leaves the caller
    // unable to tell a checkbox it mis-tapped from a date field that cannot be
    // cleared this way. Both refusals carry the type.
    expect(run(el("INPUT", { type: "checkbox" })).outcome.focus).toBe("input type=checkbox");
    // A textarea has no `type` worth reporting — its `.type` is the constant
    // "textarea" — so the label stays the bare tag rather than "textarea
    // type=textarea".
    expect(run(el("TEXTAREA", { disabled: true })).outcome.focus).toBe("textarea");
    // An omitted `type` reflects as "text" in the DOM; the script normalises to
    // the same, so a bare <input> is never reported as `type=undefined`.
    expect(run(el("INPUT", {}), { delete: false }).outcome.focus).toBe("input type=text");
  });
});

// The bug this half exists for: Chromium's five date/time input types pass
// every editability signal the script can read — they are not in the denylist,
// they are not readonly or disabled, they are `<input>` — and `execCommand`
// still leaves their value in place, because it is structured rather than text.
// Discarding `delete`'s return value therefore answered `cleared: true` for a
// field that still held its date, and the caller's next step typed the
// replacement INTO the retained value. That is the exact data bug clearing
// exists to prevent, so it is a refusal, with its own code and its own repair.
describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a delete the element refuses", () => {
  it.each(DATE_TIME_TYPES)("refuses <input type=%s>, whose delete Chrome answers false", (type) => {
    // The refusal is declared on the ELEMENT, not on the document: that is where
    // Chrome's answer comes from, and a mock that answered by command name alone
    // would pass a script that never looked at the focused element.
    const { outcome, commands } = run(el("INPUT", { type, deleteAnswer: false }));
    expect(outcome).toEqual({
      cleared: false,
      focus: `input type=${type}`,
      reason: "delete-refused",
    });
    // It still TRIED — the refusal is read from the attempt, not predicted from
    // the type. An allowlist of known-bad types would pass this assertion on
    // `outcome` alone while going stale the next time Chromium adds one.
    // Measured on Chrome 151: `.select()` leaves `delete` answering false for
    // these five exactly as `execCommand("selectAll")` did.
    expect(commands).toEqual(["select", "delete"]);
  });

  it("reads `disabled` / `readOnly` only where they are IDL attributes", () => {
    // A component library that exposes `disabled` as a plain JS property on a
    // non-form host — `ce.disabled = true` on a <div contenteditable>, the shape
    // a wrapper component takes — made a perfectly clearable field refuse with
    // "nothing can be until the app enables it", a repair the caller cannot act
    // on. Measured on Chrome 151: the same field clears.
    const { outcome, commands } = run(el("DIV", { isContentEditable: true, disabled: true }));
    expect(outcome).toEqual({ cleared: true, focus: "div" });
    expect(commands).toEqual(["selectAll", "delete"]);
    expect(run(el("DIV", { isContentEditable: true, readOnly: true })).outcome.cleared).toBe(true);
    // The positive control: on a form control they still decide.
    expect(run(el("INPUT", { type: "text", readOnly: true })).outcome.reason).toBe("readonly");
    expect(run(el("TEXTAREA", { disabled: true })).outcome.reason).toBe("disabled");
  });

  it("selects the text control's OWN value, not the document's selection", () => {
    // The bug this replaces: `execCommand("selectAll")` acts on the DOCUMENT's
    // selection, so a page selection anchored outside the focused control — the
    // everyday copy-to-clipboard button that highlights a code block and keeps
    // focus in the field — selected the whole document instead, `delete`
    // refused, and an ordinary <input> was reported unclearable with the
    // date-input wording. Measured on Chrome 151, and `.select()` clears the
    // same field.
    //
    // The mock answers `selectAll: false`, so a script that still routed a text
    // control through `execCommand` would take the delete-refused branch.
    const { outcome, commands } = run(
      el("INPUT", { type: "text", selectAllAnswer: false, deleteAnswer: true })
    );
    expect(outcome).toEqual({ cleared: true, focus: "input type=text" });
    expect(commands).toEqual(["select", "delete"]);
  });

  it("takes the delete's answer from the FOCUSED element, not from the page", () => {
    // Chrome answers `delete` per element: on one page a text input accepts it
    // and a date input refuses it. A script that read a page-wide answer — or a
    // test whose mock supplied one — could not tell those apart, which is the
    // whole basis of the delete-refused classification. Same page, same
    // document-level answer, opposite verdicts.
    const refuses = el("INPUT", { type: "date", deleteAnswer: false });
    const accepts = el("INPUT", { type: "text", deleteAnswer: true });
    expect(run(refuses, { delete: true }).outcome.reason).toBe("delete-refused");
    expect(run(accepts, { delete: false }).outcome.cleared).toBe(true);
  });

  it("follows the per-element answer into an open shadow root", () => {
    // The descent decides which element the commands act on, so the answer has
    // to come from the element the descent lands on, not from the host.
    const inner = el("INPUT", { type: "date", deleteAnswer: false });
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner }, deleteAnswer: true });
    expect(run(host).outcome).toEqual({
      cleared: false,
      focus: "input type=date",
      reason: "delete-refused",
    });
  });

  it("separates the two refusals by `reason`, not only by wording", () => {
    // The backend branches on `reason` to pick the code and the repair — tap
    // the field, versus press backspace on the field you already focused.
    expect(run(el("BUTTON", {})).outcome.reason).toBe("not-editable");
    expect(run(el("INPUT", { type: "date", deleteAnswer: false })).outcome.reason).toBe(
      "delete-refused"
    );
  });

  it("still clears when only `selectAll` answers false", () => {
    // An ALREADY-empty text field: Chrome answers `selectAll: false` (there was
    // nothing to select) and `delete: true`. Reading the wrong one of the two
    // would turn every clear of an empty field into a spurious failure — and an
    // empty field is the ordinary state of a field a flow just cleared.
    const { outcome, commands } = run(el("INPUT", { type: "text", selectAllAnswer: false }));
    expect(outcome).toEqual({ cleared: true, focus: "input type=text" });
    expect(commands).toEqual(["select", "delete"]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — focus inside a shadow root", () => {
  it("descends into the shadow root to find the real input", () => {
    // A custom element that wraps an <input> is the ordinary design-system
    // field. `document.activeElement` only ever names the HOST, so without the
    // descent every such field reports as a non-editable custom tag and the
    // clear is refused on a page where a clear is exactly what is wanted.
    const inner = textInput();
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: true, focus: "input type=text" });
    expect(commands).toEqual(["select", "delete"]);
  });

  it("descends through nested shadow roots", () => {
    // Two levels: a design-system field inside a design-system form row. The
    // walk is a loop rather than one step, and a single-step version passes the
    // test above.
    const inner = el("TEXTAREA", {});
    const mid = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const host = el("MY-ROW", { shadowRoot: { activeElement: mid } });
    expect(run(host).outcome).toEqual({ cleared: true, focus: "textarea" });
  });

  it("stops at a host whose shadow root focuses nothing, and refuses it by its own tag", () => {
    // The loop's exit condition. A host with a shadow root but no focus inside
    // it is not an editable, and the refusal has to name the host — descending
    // into `null` would throw inside the renderer and surface as an evaluate
    // failure instead of the actionable "tap the field first".
    const host = el("MY-FIELD", { shadowRoot: { activeElement: null } });
    expect(run(host).outcome).toEqual({
      cleared: false,
      focus: "my-field",
      reason: "not-editable",
    });
  });

  it("refuses a readonly input that lives inside a shadow root", () => {
    // The editability check has to run on the element the descent landed on,
    // not on the host: a walk that decided before descending would clear this.
    const inner = el("INPUT", { type: "text", readOnly: true });
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: false, focus: "input type=text", reason: "readonly" });
    expect(commands).toEqual([]);
  });
});

// The refusals that only exist because a real browser does something a
// classification-by-tag cannot predict. Each was measured on Chrome 151 first;
// the mock is what keeps the branch from being deleted as dead code.
describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — the document as its own editing host", () => {
  /** `document.body` / `document.documentElement`, as the script compares them. */
  function withDocumentRoots(active: unknown, extras: Record<string, unknown> = {}) {
    return { body: active, documentElement: {}, ...extras };
  }

  it("refuses a designMode / <body contenteditable> page without selecting anything", () => {
    // Measured on Chrome 151: with `designMode = "on"`, `document.activeElement`
    // is <body>, `isContentEditable` is true, and `selectAll` + `delete` empties
    // the ENTIRE page — a body of 288 characters and 7 ids down to 85 and 1.
    // Nothing bounds an editing host, and this needs no prior interaction at
    // all, so the refusal is by identity rather than by editability.
    const body = el("BODY", { isContentEditable: true });
    const { outcome, commands } = run(body, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: false, focus: "body", reason: "document-editable" });
    expect(commands).toEqual([]);
  });

  it("still refuses <html> as the editing host, not only <body>", () => {
    const root = el("HTML", { isContentEditable: true });
    const { outcome } = run(root, {}, { body: {}, documentElement: root });
    expect(outcome.reason).toBe("document-editable");
  });

  it("clears a real field on the SAME designMode page", () => {
    // The positive control. A refusal written as "designMode is on" rather than
    // "the EDITING HOST is the document" would make every field on such a page
    // unclearable — which is the ordinary case once the caller has tapped one.
    const body = el("BODY", { isContentEditable: true });
    // A focused <input> inherits `isContentEditable` (measured on Chrome 151),
    // and it is still an input: its own value is what select-and-delete empties,
    // so the walk up to the host must not capture it.
    const field = el("INPUT", { type: "text", isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(field, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: true, focus: "input type=text" });
    expect(commands).toEqual(["select", "delete"]);
  });

  it("refuses a focused DESCENDANT of a document-wide editing host", () => {
    // The reachable route, and it needs no interaction at all: `autofocus` on a
    // <button> inside <body contenteditable>. Every element inside such a host
    // reports `isContentEditable === true`, so a test on the FOCUSED node lets
    // the button past and `selectAll` + `delete` then empties the page —
    // measured on Chrome 151 at 160 characters of <body> down to "<br>",
    // reported as `{ cleared: true }`.
    const body = el("BODY", { isContentEditable: true });
    const button = el("BUTTON", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(button, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: false, focus: "button", reason: "document-editable" });
    expect(commands).toEqual([]);
  });

  it("walks PAST an intermediate editable ancestor to reach the host", () => {
    // Under `designMode` the host is <html>, so the walk has to keep going past
    // <body>; stopping at the first editable ancestor would let this through.
    const html = el("HTML", { isContentEditable: true });
    const body = el("BODY", { isContentEditable: true, parentElement: html });
    const div = el("DIV", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(div, {}, { body, documentElement: html });
    expect(outcome.reason).toBe("document-editable");
    expect(commands).toEqual([]);
  });

  it("still clears a contenteditable whose editing host is NOT the document", () => {
    // The regression guard for the walk: an ordinary rich-text editor is a
    // <div contenteditable> under a non-editable <body>, so the walk stops on
    // the div and the clear proceeds as it always did.
    const body = el("BODY", { isContentEditable: false });
    const editor = el("DIV", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(editor, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: true, focus: "div" });
    expect(commands).toEqual(["selectAll", "delete"]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a host script cannot see into", () => {
  it("REFUSES a custom element with no reachable shadow root, without selecting anything", () => {
    // `attachShadow({mode:"closed"})` leaves `el.shadowRoot` null, so the
    // descent stops on the host and the tag test cannot see the <input> that
    // may hold focus. Deleting blind there was measured on Chrome 151 to empty
    // a DIFFERENT editor — `execCommand` acts on the document's selection, not
    // on the focused element — while `delete` answers true whether or not it
    // removed anything and an opaque host cannot be read back to check. So the
    // command list must stay EMPTY: nothing selected, nothing deleted.
    const { outcome, commands } = run(el("MY-FIELD", { childNodes: [] }));
    expect(outcome).toEqual({ cleared: false, focus: "my-field", reason: "host-opaque" });
    expect(commands).toEqual([]);
  });

  it("refuses a light-DOM custom element the same way", () => {
    // `<my-field><input></my-field>` (the Stencil `shadow: false` / Lit
    // `createRenderRoot` default) is the same shape from outside, and focus on
    // the HOST is not focus on the field — the old hyphen test let it through
    // and reported a success with the inner value untouched.
    const { outcome, commands } = run(el("MY-FIELD", { childNodes: [{}] }));
    expect(outcome).toEqual({ cleared: false, focus: "my-field", reason: "host-opaque" });
    expect(commands).toEqual([]);
  });

  it("gives a NON-hyphenated closed-shadow host the same reason, not 'tap the field'", () => {
    // `<div>` + `attachShadow({mode:"closed"})` hosts one too, and its empty
    // light subtree is the tell. `not-editable` would answer "tap the field
    // first" to an element that already HAS focus, which is a loop.
    const { outcome, commands } = run(el("DIV", { childNodes: [] }));
    expect(outcome).toEqual({ cleared: false, focus: "div", reason: "host-opaque" });
    expect(commands).toEqual([]);
  });

  it("does not read an icon-only <button> as a host hiding a field", () => {
    // An empty light subtree is the tell for a closed shadow root only on an
    // element that can HAVE one. `attachShadow` throws NotSupportedError outside
    // the spec's list plus a valid custom element name, so a childless <button>
    // cannot be hiding a field — and "tap the field inside it" withholds the one
    // repair that works. Measured on Chrome 152: the same
    // `<button aria-label="Clear search">` got `KEYBOARD_CLEAR_UNSUPPORTED_FIELD`
    // with no children and `KEYBOARD_CLEAR_NO_EDITABLE_FOCUS` with one <svg>.
    expect(run(el("BUTTON", { childNodes: [] })).outcome).toEqual({
      cleared: false,
      focus: "button",
      reason: "not-editable",
    });
    expect(run(el("BUTTON", { childNodes: [{}] })).outcome.reason).toBe("not-editable");
    // Still a host where one is possible: the hyphen and the shadow-hostable
    // tags keep the opaque diagnosis.
    expect(run(el("SPAN", { childNodes: [] })).outcome.reason).toBe("host-opaque");
  });

  it("still reports an ordinary non-editable element as a focus problem", () => {
    // These have light content of their own, so nothing is hidden and "tap the
    // field first" is the right repair.
    expect(run(el("VIDEO", { childNodes: [{}] })).outcome.reason).toBe("not-editable");
    expect(run(el("SUMMARY", { childNodes: [{}] })).outcome.reason).toBe("not-editable");
  });

  it("does not try a host whose OPEN shadow root simply focuses nothing", () => {
    // `shadowRoot` is readable there, so the descent already had its chance and
    // the host genuinely holds focus. Trying it anyway would select and delete
    // against a page the script CAN inspect and has judged non-editable.
    const host = el("MY-FIELD", { shadowRoot: { activeElement: null } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: false, focus: "my-field", reason: "not-editable" });
    expect(commands).toEqual([]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — it leaves nothing behind", () => {
  it("RESTORES the page's own selection when the delete is refused", () => {
    // The select-all has already run by then, and on a field Chrome then refuses
    // it selects the WHOLE DOCUMENT — measured on Chrome 151 for a focused date
    // input, where `document.getSelection()` came back holding the page text.
    // Left in place, that highlight reaches the next screenshot and every
    // screenshot-diff taken after it.
    //
    // Dropping it is not enough either: a call that reports "nothing was
    // cleared" and still takes the page from one highlighted range to none has
    // changed visible state. Measured on Chrome 151 against the standard
    // copy-to-clipboard shape, `rangeCount` went 1 -> 0.
    const { outcome, selectionsDropped, selection } = run(
      el("INPUT", { type: "date", deleteAnswer: false })
    );
    expect(outcome.reason).toBe("delete-refused");
    expect(selectionsDropped).toBe(1);
    expect(selection()).toEqual([{ id: "page-selection" }]);
  });

  it("restores it when the page throws BETWEEN the select-all and the delete", () => {
    // The sibling hazard: `selectAll` succeeded, `delete` threw, and this branch
    // returned without undoing the page-wide highlight the first half left.
    //
    // The restore is declared outside the `try` for exactly this call. As a
    // `const` inside it, the name was not in scope in the `catch` — the call
    // threw a ReferenceError that the inner try swallowed, and on Chrome 152 it
    // resolved to the PAGE's own `window.restoreSelection` where one is defined.
    // `selectionsDropped` is what sees that: it counts `removeAllRanges`. Two on
    // this path — the script clears the page's own range to put the selection
    // inside the editing host, so the select-all has an editable root to scope
    // to, and the restore clears that one again to put the page's back. The
    // range that ends up selected is the assertion that matters.
    const { outcome, selection, selectionsDropped } = run(
      el("DIV", { isContentEditable: true }),
      {},
      {
        execCommand(name: string) {
          commandLog.push(name);
          if (name === "delete") throw new Error("editor took over");
          return true;
        },
      }
    );
    expect(outcome.reason).toBe("script-error");
    expect(selectionsDropped).toBe(2);
    expect(selection()).toEqual([{ id: "page-selection" }]);
  });

  it("aims the select-all at the focused host when the page's selection is elsewhere", () => {
    // `selectAll` scopes to the root editable of WHERE THE SELECTION IS, not of
    // the focused element. Anchored outside — the copy-to-clipboard shape the
    // input path was already fixed for — it has no editable root and selects the
    // WHOLE DOCUMENT, which `delete` then refuses. Measured on Chrome 152 with
    // focus on a plain <div contenteditable> and the page selection on a <p>:
    // the field was diagnosed as holding a block the editor will not remove, and
    // sent to a `gesture-drag` that is not its repair.
    const editor = el("DIV", { isContentEditable: true });
    const outside = run(editor);
    expect(outside.outcome).toEqual({ cleared: true, focus: "div" });
    expect(outside.hostRanges).toHaveLength(1);
    expect(outside.hostRanges[0]!.node).toBe(editor);
    expect(outside.commands).toEqual(["selectAll", "delete"]);
  });

  it("leaves a selection already inside the host alone", () => {
    // A nested editable keeps scoping to its outer host exactly as before, and
    // a caller's own range inside the field is not replaced.
    const inside = run(el("DIV", { isContentEditable: true, contains: () => true }));
    expect(inside.outcome).toEqual({ cleared: true, focus: "div" });
    expect(inside.hostRanges).toEqual([]);
    expect(inside.commands).toEqual(["selectAll", "delete"]);
  });

  it("puts the PAGE's range back when a contenteditable refuses the delete", () => {
    // The only shape where the restore has real work: a contenteditable takes
    // the select-all (which replaces the page's range), and a refused delete
    // then has to undo it. Every `deleteAnswer: false` case here is an <input>,
    // which takes `el.select()` instead and never reaches the select-all — so
    // the restore was only ever observed as a call count, never as the range it
    // put back.
    //
    // It also pins the ORDER: the page's ranges are cloned before the select-all
    // replaces them. Clone after it and this restores the select-all's own
    // range instead, which is the page-wide highlight the restore exists to
    // remove.
    const { outcome, selection, selectionsDropped } = run(
      el("DIV", { isContentEditable: true, deleteAnswer: false })
    );
    expect(outcome.reason).toBe("delete-refused");
    expect(selection()).toEqual([{ id: "page-selection" }]);
    // Two: the script clears the page's range to scope the select-all to the
    // host, and the restore clears that one again to put the page's back.
    expect(selectionsDropped).toBe(2);
  });

  it("touches nothing on a refusal that never selected", () => {
    // The other refusals return before the select-all, so there is no selection
    // to undo — and touching it there would disturb a selection the USER or a
    // previous `gesture-drag` made.
    expect(run(el("BUTTON", {})).selectionsDropped).toBe(0);
    expect(run(el("INPUT", { type: "text", readOnly: true })).selectionsDropped).toBe(0);
  });

  it("leaves the selection alone on a successful clear", () => {
    // The delete consumed it; putting the old ranges back would resurrect a
    // highlight over content that is gone.
    expect(run(textInput()).selectionsDropped).toBe(0);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — the record it leaves for the read-back", () => {
  it("parks the cleared element and a signature of what it held", () => {
    // The read-back reads this record and nothing else: the element by IDENTITY
    // (two fields of one kind share a label, so an auto-advancing OTP form had
    // the next field's contents attributed to the one just cleared) and the
    // signature it compares against to tell a value that SURVIVED from one the
    // page REPLACED.
    const field = el("INPUT", { type: "text", value: "hello world" });
    const { parked } = run(field);
    expect(parked?.el).toBe(field);
    expect(parked?.before).toBe(signatureOf(field));
  });

  it("parks a digest, never the value itself", () => {
    // It sits on the PAGE's own `window`, in its main world, and the read-back
    // that deletes it is exactly the call `evaluateClearStep` exists to handle
    // failing — so a raw value stays resident for the life of the document. A
    // cleared field is often a credential.
    const password = el("INPUT", { type: "password", value: "hunter2-SUPERSECRET" });
    const { parked } = run(password);
    expect(String(parked?.before)).not.toContain("hunter2");
    // And it is still a signature of THAT value: a constant would compare equal
    // for every field.
    expect(parked?.before).not.toBe(signatureOf(el("INPUT", { type: "password", value: "other" })));
  });

  it("parks nothing when the clear was refused", () => {
    // A record left behind by a refused clear would be inherited by the NEXT
    // clear's read-back, which drops it on read.
    expect(run(el("INPUT", { type: "text", readOnly: true })).parked).toBeUndefined();
  });

  it("survives a page that sealed `window`", () => {
    // The stash is best-effort: a page can make the assignment throw, and the
    // clear still has to succeed — the read-back then simply has no identity.
    const sealed = Object.freeze({});
    const g = globalThis as Record<string, unknown>;
    const saved = g.window;
    g.window = sealed;
    try {
      expect(run(textInput()).outcome).toEqual({ cleared: true, focus: "input type=text" });
    } finally {
      g.window = saved;
    }
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a page that breaks the script", () => {
  it("reports the page's own error instead of an imagined focus problem", () => {
    // Editors and polyfills replace or delete `document.execCommand`. The throw
    // used to leave `Runtime.evaluate`'s `result.value` undefined, which the
    // backend read as "no element has keyboard focus" — the wrong cause, and a
    // repair (tap the field) that cannot work.
    const { outcome } = run(
      textInput(),
      {},
      {
        execCommand() {
          throw new TypeError("execCommand was replaced by the editor");
        },
      }
    );
    expect(outcome.cleared).toBe(false);
    expect(outcome.reason).toBe("script-error");
    expect(outcome.detail).toMatch(/execCommand was replaced/);
    // No `focus`: nothing was classified, so claiming one would be a guess.
    expect(outcome.focus).toBeUndefined();
  });
});

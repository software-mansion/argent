import { describe, expect, it } from "vitest";
import {
  CLEAR_READBACK_SCRIPT,
  CONTENT_SIGNATURE_JS,
} from "../src/tools/keyboard/platforms/chromium";

/**
 * `CLEAR_READBACK_SCRIPT` is the SECOND evaluate of a Chromium clear, and it is
 * what decides whether an accepted delete is reported or refused. Every other
 * test can mock its return value, so the decision itself — which element is
 * read, whether it counts `value` or trimmed text, what counts as content at
 * all — is observable only by evaluating the real source. Mirrors
 * keyboard-clear-chromium-script.test.ts, which evals its sibling the same way.
 */

interface Readback {
  focus?: string | null;
  same?: boolean;
  changed?: boolean;
  remaining?: number | null;
  embeds?: number;
}

/** One element as the script sees it. `tagName` is uppercase, as in a real DOM. */
function el(tagName: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return { tagName, isConnected: true, ...props };
}

/** A contenteditable whose embedded (text-less) content the script counts. */
function editable(text: string, embeds: unknown[] = []): Record<string, unknown> {
  return el("DIV", {
    isContentEditable: true,
    textContent: text,
    querySelectorAll: () => embeds,
  });
}

/**
 * Eval the script with `document.activeElement` pointing at `focused` and the
 * clear's stashed record on `window`. Indirect eval so the IIFE runs in global
 * scope and reads the injected globals, as it does in a page.
 */
function run(
  focused: unknown,
  record?: { el: unknown; before: unknown }
): { readback: Readback; targetLeftBehind: boolean } {
  const g = globalThis as Record<string, unknown>;
  const hadDoc = Object.hasOwn(g, "document");
  const savedDoc = g.document;
  const hadWin = Object.hasOwn(g, "window");
  const savedWin = g.window;
  const win: Record<string, unknown> = {};
  if (record !== undefined) win.__argentClearTarget = record;
  g.document = { activeElement: focused };
  g.window = win;
  try {
    const readback = (0, eval)(CLEAR_READBACK_SCRIPT) as Readback;
    return { readback, targetLeftBehind: Object.hasOwn(win, "__argentClearTarget") };
  } finally {
    if (hadDoc) g.document = savedDoc;
    else delete g.document;
    if (hadWin) g.window = savedWin;
    else delete g.window;
  }
}

/**
 * The signature the clear script stashes, for an element the script reads.
 *
 * Evaluated from the SAME source both scripts interpolate, rather than
 * hand-copied: the two stages compare their answers across two evaluates, so a
 * third copy that drifted would leave this file agreeing with itself and with
 * neither script.
 */
const signatureOf = (0, eval)(`(node) => { ${CONTENT_SIGNATURE_JS} return contentOf(node); }`) as (
  node: Record<string, unknown>
) => string | null;

describe("CLEAR_READBACK_SCRIPT — which element it reads", () => {
  it("reads the element the clear ran against, not whatever holds focus now", () => {
    // The whole point of the stashed target: an editor that restores its value
    // and hands focus to a hidden IME buffer (ProseMirror / Slate / Quill) —
    // and a field that blurs on change — both leave focus on something with
    // nothing to read, and the restored value was reported as `cleared: true`.
    const target = el("INPUT", { type: "text", value: "SECRETVALUE" });
    const elsewhere = el("BODY", {});
    const { readback } = run(elsewhere, { el: target, before: signatureOf(target) });
    expect(readback.focus).toBe("input type=text");
    expect(readback.same).toBe(true);
    expect(readback.remaining).toBe(11);
  });

  it("drops the stashed target, so a later clear cannot inherit it", () => {
    const target = el("INPUT", { type: "text", value: "" });
    const { targetLeftBehind } = run(target, { el: target, before: "" });
    expect(targetLeftBehind).toBe(false);
  });

  it("will not be contradicted by a target the page REPLACED", () => {
    // A detached node keeps the old value while the live field on screen is
    // empty, so it is no evidence about what is there now.
    const detached = el("INPUT", { type: "text", value: "OLD", isConnected: false });
    const { readback } = run(el("BODY", {}), { el: detached, before: "OLD" });
    expect(readback.same).toBe(false);
  });

  it("falls back to the focused element when nothing was stashed", () => {
    // A page can seal `window`, and then the clear script's stash silently
    // fails. The read still happens; it just cannot claim to be the same
    // element, so it cannot contradict the delete.
    const { readback } = run(el("INPUT", { type: "text", value: "still here" }));
    expect(readback.same).toBe(false);
    expect(readback.remaining).toBe(10);
  });

  it("descends into an open shadow root to find the real field", () => {
    // `document.activeElement` only ever names the host; the <input> that holds
    // focus lives inside. Same descent as the clear script's.
    const inner = el("INPUT", { type: "password", value: "abc" });
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const { readback } = run(host);
    expect(readback.focus).toBe("input type=password");
    expect(readback.remaining).toBe(3);
  });
});

describe("CLEAR_READBACK_SCRIPT — what it counts as still there", () => {
  it("counts an <input>/<textarea> by its value, untrimmed", () => {
    // A form control's value is its value: leading and trailing spaces are part
    // of what the field holds, and trimming them would report a field holding
    // "   " as empty.
    expect(run(el("INPUT", { type: "text", value: "  " })).readback.remaining).toBe(2);
    expect(run(el("TEXTAREA", { value: "ab" })).readback.remaining).toBe(2);
    // A null/undefined value reads as empty rather than as "null".
    expect(run(el("INPUT", { type: "text", value: null })).readback.remaining).toBe(0);
  });

  it("counts a contenteditable by END-TRIMMED text, with zero-width seeds stripped", () => {
    // A cleared contenteditable keeps a placeholder <br> or an empty <p>, and an
    // editor may seed a zero-width space — none of which is a surviving value.
    // Without the strip and the trim, every contenteditable clear would come
    // back as a false KEYBOARD_CLEAR_UNSUPPORTED_FIELD.
    expect(run(editable("\n  \n")).readback.remaining).toBe(0);
    expect(run(editable("\u200b\ufeff")).readback.remaining).toBe(0);
    // Interior whitespace is part of the text, and the count is quoted back to
    // the caller — so it is trimmed at the ENDS only.
    expect(run(editable("  a b  ")).readback.remaining).toBe(3);
  });

  it("counts content that HAS no text, which the character count cannot see", () => {
    // An inline image, attachment chip, embed or table reads
    // `textContent.length` 0 before AND after, so a restored one used to read as
    // an emptied field.
    const { readback } = run(editable("", [{}, {}]));
    expect(readback.remaining).toBe(0);
    expect(readback.embeds).toBe(2);
  });

  it("reports `remaining: null` when there is nothing with a value to read", () => {
    // Not evidence of anything: the delete already reported success, and this
    // says only that the read found nothing to look at.
    const { readback } = run(el("BODY", {}));
    expect(readback.remaining).toBeNull();
    expect(readback.embeds).toBe(0);
  });
});

describe("CLEAR_READBACK_SCRIPT — whether the value is the one that was aimed at", () => {
  it("reports `changed: false` for a value the page restored", () => {
    // The restoring editor: what is there now is what was there before, so the
    // caller's value is intact and "nothing was cleared" is the truth.
    const target = editable("IMPORTANT DRAFT TEXT");
    const { readback } = run(target, { el: target, before: signatureOf(target) });
    expect(readback.changed).toBe(false);
    expect(readback.remaining).toBe(20);
  });

  it("reports `changed: true` for a value the page REWROTE", () => {
    // A currency, phone or card mask reseeds its own value on `input`, so the
    // field is non-empty while the caller's value is already destroyed —
    // "nothing was cleared" is false twice over there.
    const before = signatureOf(el("INPUT", { type: "text", value: "1,234.56" }));
    const after = el("INPUT", { type: "text", value: "0.00" });
    const { readback } = run(after, { el: after, before });
    expect(readback.changed).toBe(true);
    expect(readback.remaining).toBe(4);
  });

  it("sees a change that is only in the text-less content", () => {
    // The signature carries the embed count too, so an editor that swaps one
    // image for two — no characters either side — is still a change.
    const before = signatureOf(editable("", [{}]));
    const after = editable("", [{}, {}]);
    const { readback } = run(after, { el: after, before });
    expect(readback.changed).toBe(true);
  });

  it("claims no change when it did not read the target", () => {
    // `changed` is only meaningful about the element the clear ran against.
    expect(run(el("INPUT", { type: "text", value: "x" })).readback.changed).toBe(false);
  });
});

import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi, type AXTreeNode } from "../../blueprints/ax-service";

/**
 * Reading back what `keyboard` typed on an iOS simulator (#2030).
 *
 * A simulator-server ack says the server took a key, not that the app got it:
 * a stalled simulator still drops keys, or repeats one whose Up arrived late,
 * and every key was acked. The field is the only witness, so it is read back.
 *
 * `keyboard` inserts at the caret rather than replacing the field, so the
 * field is judged only where that means something: it was empty before
 * typing, and must hold the typed text after. Any other case types without a
 * check, as before.
 *
 * Both reads go through the tree, which answers at once. The ax-service check
 * answers "no" only after its 1 s wait, and the daemon serves one request at
 * a time, so a check given up on would hold up every later ax-service
 * request, the orientation read of each touch among them. The check runs only
 * where the tree cannot tell (a secure field shows bullets, or the app has
 * not applied the last key yet), and is always waited for.
 *
 * The tree also shows which input is focused. When focus moved on while
 * typing, as on a code screen that advances one box per digit, the focused
 * input is not the one typed into, and nothing is judged.
 *
 * A mismatch is a warning, not a failure: the keys may be fine and the app or
 * iOS may have changed the text on purpose (auto-correction, a formatter, a
 * length limit, a field that capitalizes every letter). The warning never
 * quotes the text: it may be a secret.
 */

/** Mutable for tests only. */
export const READBACK_TIMING = {
  /** Budget to reach the ax-service; past it, typing goes on unchecked. */
  resolveMs: 1_500,
  /**
   * Budget for each tree read. Before typing, past it the typing goes on
   * unchecked; after typing, the ax-service check decides.
   */
  treeMs: 1_500,
  /**
   * Budget for the ax-service check after typing. It must outlast the
   * daemon's 1 s wait, or a field that does not hold the text never answers
   * "no". The daemon's wait also gives an app that applies input late the
   * time it needs.
   */
  checkMs: 3_500,
};

// Return and Tab can submit a form or move focus, so the field read after
// them is not the one typed into.
const FOCUS_MOVING = /[\r\n\t]/;

export interface ReadbackOutcome {
  /**
   * True when the field holds the typed text, apart from what iOS changes as
   * the keys arrive (a capital at the start of a word, smart punctuation);
   * false with `warning` when it does not.
   */
  verified: boolean;
  warning?: string;
}

export const READBACK_MISMATCH_WARNING =
  "After typing, the focused field does not hold the text that was sent. Keys may have been " +
  "dropped or repeated (a stalled simulator does this, and the keys were still acknowledged), " +
  "or the app or iOS changed the text (auto-capitalization, auto-correction, an input formatter, " +
  "a length limit). Read the field before submitting; to retype, clear it first.";

/** Resolves to `undefined` instead of waiting past `ms`, and on any failure. */
async function within<T>(ms: number, run: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Through `then`, so a synchronous throw is caught as well.
      Promise.resolve()
        .then(run)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Types with `type` and, where the check means something, reads the field
 * back. Never fails on the check itself: a missing or unreadable ax-service
 * leaves the typing unchecked, with no outcome.
 */
export async function typeWithReadback<T>(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  type: () => Promise<T>
): Promise<{ result: T; readback?: ReadbackOutcome }> {
  if (!text || FOCUS_MOVING.test(text)) return { result: await type() };

  const ax = await within(READBACK_TIMING.resolveMs, async () => {
    const ref = axServiceRef(device);
    const api = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
    return api.degraded ? undefined : api;
  });
  const readTree = async () =>
    ax ? (await within(READBACK_TIMING.treeMs, () => ax.tree()))?.nodes : undefined;

  const before = await readTree();
  const field = before && focusedInput(before);
  const typedInto = field && heldText(field) === "" ? field : undefined;

  const result = await type();
  if (!ax || !typedInto) return { result };

  // "unread" when the tree read gave up: a busy app answers late, and that
  // says nothing about the field.
  const judge = async () => {
    const nodes = await readTree();
    return nodes ? judgeTree(nodes, typedInto, text) : "unread";
  };
  const verified = { result, readback: { verified: true } };

  const early = await judge();
  if (early === "holds") return verified;
  if (early === "moved") return { result };

  const after = await within(READBACK_TIMING.checkMs, () => ax.fill(text, { check: true }));
  if (after?.verified) return verified;
  // No answer, or focus left the field (the app moved it): nothing to judge.
  if (!after || !after.focused || after.timedOut) return { result };
  // The check waited up to 1 s, so an app that applies input late has done
  // so by now: read the tree again before calling it a mismatch.
  const late = await judge();
  if (late === "holds") return verified;
  // The check compares exactly, so it says "no" to text iOS changed on
  // purpose too (a capital, a curled quote). Only the tree can accept that;
  // a tree read that gave up, as when the app is busy re-filtering a list,
  // leaves the field unjudged rather than mismatched.
  if (late === "moved" || late === "unread") return { result };
  return { result, readback: { verified: false, warning: READBACK_MISMATCH_WARNING } };
}

/**
 * What the tree says about the typed text: the input typed into holds it,
 * focus moved on to another input (or off every input), or it cannot tell.
 */
function judgeTree(
  nodes: AXTreeNode[],
  typedInto: AXTreeNode,
  text: string
): "holds" | "moved" | undefined {
  const focused = focusedInput(nodes);
  if (!focused || !sameInput(focused, typedInto)) return "moved";
  const held = heldText(focused);
  return held !== undefined && holdsTyped(text, held) ? "holds" : undefined;
}

// XCUIElementType values of the inputs that take typed text.
const SECURE_TEXT_FIELD = 50;
const TEXT_INPUT_TYPES = new Set([
  45 /* searchField */,
  49 /* textField */,
  SECURE_TEXT_FIELD,
  52 /* textView */,
]);

/** The input that has keyboard focus. */
function focusedInput(nodes: AXTreeNode[]): AXTreeNode | undefined {
  return nodes.find(
    (node) =>
      node.traits?.includes("isEditing") &&
      node.elementType !== undefined &&
      TEXT_INPUT_TYPES.has(node.elementType)
  );
}

/** The input's text, or undefined for a secure input that holds some: it shows bullets. */
function heldText(node: AXTreeNode): string | undefined {
  if (node.hintShowing) return "";
  if (node.elementType === SECURE_TEXT_FIELD) return node.value ? undefined : "";
  return node.value ?? "";
}

/**
 * Whether two reads show the same input, told by its place: the two frames
 * cover mostly the same area. Two inputs do not overlap, while one input can
 * move and change size a little as it fills: a search field narrows for its
 * clear button and slides over, a text view grows.
 */
function sameInput(a: AXTreeNode, b: AXTreeNode): boolean {
  if (a.elementType !== b.elementType) return false;
  if (!a.frame || !b.frame) return true;
  const [p, q] = [a.frame, b.frame];
  const width = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
  const height = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  if (width <= 0 || height <= 0) return false;
  const smaller = Math.min(p.width * p.height, q.width * q.height);
  return width * height >= smaller / 2;
}

/**
 * Whether `held` is what iOS leaves in a UIKit text field for `typed` as the
 * keys arrive: the same text, with smart punctuation, and with the first
 * letters of some words made capital. Both are on by default.
 */
export function holdsTyped(typed: string, held: string): boolean {
  const a = plainPunctuation(typed);
  const b = plainPunctuation(held);
  return a === b || capitalizedByIos(a, b);
}

/**
 * Undoes smart punctuation: curly apostrophes and quotes back to straight
 * ones, and a dash for two hyphens on both sides. The quotes follow the host
 * keyboard's language, which simulator-server passes through: „ ” in German,
 * « » in French or Russian, the French ones with a no-break space inside.
 */
function plainPunctuation(text: string): string {
  return text
    .replace(/‹[\u00A0\u202F]?|[\u00A0\u202F]?›/gu, "'")
    .replace(/«[\u00A0\u202F]?|[\u00A0\u202F]?»/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/--|–/gu, "—");
}

// What may come before the first letter of a word.
const WORD_OPENER = /[\s"'([{¿¡]/u;

/**
 * Whether `held` is `typed` with the first letters of some words made
 * capital, and nothing else changed. iOS does this to a UIKit text field by
 * default (auto-capitalization, of each sentence or each word). A key fault
 * does not: a held Shift capitalizes every letter after it, and a dropped or
 * repeated key changes the length. So a field that capitalizes every letter
 * still gets the warning: it reads like a held Shift.
 */
export function capitalizedByIos(typed: string, held: string): boolean {
  const a = Array.from(typed);
  const b = Array.from(held);
  if (a.length !== b.length) return false;
  let changed = false;
  for (let i = 0; i < a.length; i++) {
    const char = a[i]!;
    if (char === b[i]) continue;
    const wordStart = i === 0 || WORD_OPENER.test(a[i - 1]!);
    const lowercase = char !== char.toUpperCase();
    if (!wordStart || !lowercase || b[i] !== char.toUpperCase()) return false;
    changed = true;
  }
  return changed;
}

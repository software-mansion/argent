export interface KeyboardParams {
  udid: string;
  /** Text to type character by character. */
  text?: string;
  /**
   * Named key to press (enter, escape, arrow-*, f1–f12). Not valid on TV
   * targets, and never set alongside `text` — the tool rejects that request
   * shape (see ./index.ts), so a backend sees at most one of the two.
   */
  key?: string;
  /**
   * Empty the focused field before typing `text`. Not valid on Vega or TV
   * targets. It is the one parameter that combines with either of the other
   * two, and it always runs first: clear → text, or clear → key.
   *
   * How it is done differs by backend — a select-all + delete on iOS, Chromium
   * and Android levels with `input keycombination`; caret-to-end-of-line plus
   * one backspace per character on older Android levels, which is therefore
   * line-scoped rather than buffer-scoped.
   *
   * Android has THREE paths for it and prefers them in this order:
   *
   *   1. One atomic accessibility edit through the devtools helper
   *      (`ACTION_SET_TEXT`). No select-all chord, no per-character injection,
   *      and the field is read back afterwards — so a widget that cannot do it
   *      says so instead of reporting a clear that never happened.
   *   2. The select-all chord, when the helper cannot serve the request. A
   *      `{ clear, text }` stops AT the chord and lets `text` replace the
   *      selection, so the field is never observed empty in between; a
   *      clear-only call sends the delete and then reads the field back.
   *   3. Caret-to-end-of-line plus one backspace per character — on a level with
   *      no `input keycombination`, or to finish a chord that did not take.
   *
   * Paths 2 and 3 exist because of the same race, and it is the reason a
   * combined call is not simply the two halves run back to back: an app that
   * reacts to its field becoming empty does so asynchronously, and the reaction
   * landed mid-typing and wiped the characters already sent. See
   * `AndroidClearOptions.keepSelection` for the measurements. Whenever path 1 is
   * not the one that ran, the result carries a {@link KeyboardResult.note}
   * saying so and why.
   */
  clear?: boolean;
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
  /**
   * True when `text` was resolved from a `{{secret:…}}` placeholder, so its
   * LENGTH is credential material and must not be quoted back in an error.
   *
   * Set by the tool's own `execute` alongside the resolved text, never by the
   * caller: the zod schema does not declare it, so a request carrying it has the
   * key stripped before it gets here.
   */
  secretText?: boolean;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Present (and `true`) only when `clear` was requested and the clear
   * completed without error.
   *
   * How much that is worth depends on what the backend can observe, and only
   * one of them can observe anything:
   *
   * - Chromium reads the field before and after, and throws when it observes
   *   the value survive. It cannot always observe: a page it can't read (a
   *   cross-origin iframe), a field the page detached, or a slot assignment the
   *   page refused all fall back to best-effort, so `cleared: true` there means
   *   "seen empty, or not observable" — never "seen NOT empty".
   * - Android depends on WHICH of its three paths ran, and {@link note} says
   *   whenever it was not the first:
   *     - Atomic (devtools helper, `ACTION_SET_TEXT`): the field IS read back and
   *       compared, and a mismatch falls through to the injected paths rather
   *       than being reported. So `cleared: true` from this path is as strong as
   *       Chromium's — "seen holding the requested value".
   *     - Injected (`input`): parses the `keycombination` output, so a level
   *       without the subcommand takes the measured delete path instead of
   *       silently degrading to a one-character backspace, and a clear-only call
   *       reads the field back afterwards and finishes with a delete run if the
   *       chord left a residue. A `{ clear, text }` cannot be checked that way —
   *       the field is meant to still hold its value when the chord lands — so a
   *       widget that swallows the chord (a Flutter `TextField` does) keeps its
   *       whole value with the text spliced in at the caret, reported as
   *       cleared.
   * - The iOS HID transport is fire-and-forget and cannot read the field at
   *   all: `cleared: true` means the chord was dispatched, nothing more.
   *
   * So this is not a cross-platform guarantee that the field is empty. Assert
   * the value if that matters.
   */
  cleared?: boolean;
  /**
   * An advisory the caller should read, present only when there is one.
   *
   * Android sets it when a `clear` could not take the atomic accessibility path
   * — naming why, which weaker path ran instead, and what that path cannot
   * promise about the field. ON ANDROID, absent therefore means the clear WAS
   * the verified one, and "no note" is itself the strong result rather than the
   * absence of information.
   *
   * Nowhere else. No other backend can set it: the iOS and Chromium returns are
   * `{ typed, keys, cleared? }` literals, so an iOS chord nothing observed and a
   * Chromium clear on a page it could not read are "absent" in exactly the same
   * way. Read the absence together with the platform, not on its own.
   *
   * Never carries the field's contents or its length: it travels into the
   * agent's transcript and the tool-server's log, and a `{{secret:…}}` request
   * is aimed at the box that already holds a credential.
   */
  note?: string;
}

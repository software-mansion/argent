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
   * - Android parses the `input keycombination` output, so a level without the
   *   subcommand takes the measured delete path instead of silently degrading
   *   to a one-character backspace. It does not read the field back, though, so
   *   a widget that swallows the select-all chord on a level that HAS the
   *   subcommand leaves the following delete acting as a plain backspace: the
   *   field is left one character shorter and reported as cleared. That is a
   *   mutated field, not a no-op.
   * - The iOS HID transport is fire-and-forget and cannot read the field at
   *   all: `cleared: true` means the chord was dispatched, nothing more.
   *
   * So this is not a cross-platform guarantee that the field is empty. Assert
   * the value if that matters.
   */
  cleared?: boolean;
}

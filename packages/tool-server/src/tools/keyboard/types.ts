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
   * line-scoped rather than buffer-scoped. Android runs that same line-scoped
   * delete on a modern level too, over whatever a swallowed select-all left
   * behind — see `cleared` on {@link KeyboardResult}.
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
   * How much that is worth depends on what the backend can observe:
   *
   * - Chromium reads the field before and after, and throws when it observes
   *   the value survive. It cannot always observe: a page it can't read (a
   *   cross-origin iframe), a field the page detached, or a slot assignment the
   *   page refused all fall back to best-effort, so `cleared: true` there means
   *   "seen empty, or not observable" — never "seen NOT empty".
   * - Android parses the `input keycombination` output, so a level without the
   *   subcommand takes the measured delete path instead of silently degrading
   *   to a one-character backspace. On a level that HAS the subcommand it also
   *   reads the field back afterwards and deletes whatever the select-all left
   *   behind, so a swallowed chord over a single-line field it can read does
   *   not leave that field one character shorter under a `cleared: true`. Three
   *   things skip the repair silently: the read-back rides the screen's view
   *   hierarchy, so a screen it cannot capture — or a clear whose earlier legs
   *   already spent the budget the read needs — degrades to best-effort like
   *   iOS; it measures focused `EditText` nodes only, so a password box, a
   *   WebView input or a custom widget gets no repair, and one of those focused
   *   ANYWHERE on screen (another window's credential box) discards the reading
   *   for the target too, since the walk cannot tell which focused editable was
   *   meant; and a field reported as holding exactly its own placeholder is read
   *   as empty, so a value that happens to equal the placeholder is left alone.
   *   A fourth limits it rather than skipping it: the repair deletes backwards
   *   from end-of-LINE, so a multi-line field keeps what sits below the caret.
   * - The iOS HID transport is fire-and-forget and cannot read the field at
   *   all: `cleared: true` means the chord was dispatched, nothing more.
   *
   * So this is not a cross-platform guarantee that the field is empty. Assert
   * the value if that matters.
   */
  cleared?: boolean;
}

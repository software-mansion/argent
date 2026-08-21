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
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
}

/**
 * The read-back outcome a backend that can inspect the field contributes to its
 * result. Only the Android phone / tablet path produces one — see
 * `platforms/android-verify.ts` for why that transport needs it and the others
 * do not.
 */
export interface KeyboardVerification {
  /**
   * Whether the typed text was read back off the screen and found in the focused
   * field. `true` means the field really holds it; `false` means it demonstrably
   * does not, and `note` says so.
   *
   * Absent means the text was NOT checked — never that it was checked and found
   * fine. On an Android phone or tablet that is a check that could not conclude,
   * with `note` giving the reason; on every other backend it is that no read-back
   * exists there. Note that Android TV shares this transport's exposure to
   * dropped key events without being checked (see `platforms/tv.ts`).
   */
  verified?: boolean;
  /**
   * Advisory prose for a result that needs a caveat: what the read-back found,
   * or why it could not run. Absent when there is nothing to say — a plain
   * verified type, a named-key press, or a platform that does not verify.
   * Carries structural facts and character counts only, never the field's
   * contents. The character counts do reveal a typed secret's length, which
   * `keys` already exposes for every secret type.
   */
  note?: string;
}

export interface KeyboardResult extends KeyboardVerification {
  typed: string;
  keys: number;
}

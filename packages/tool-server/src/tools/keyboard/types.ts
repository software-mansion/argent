export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` in ./index.ts, so a backend sees at most one of
   * the two. Not valid on TV targets.
   */
  key?: string;
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
   * field. `true` means the field really holds it. `false` means the read-back
   * did not confirm that: the field was read and does not hold it, or it was
   * measured not to and the read that would have confirmed the repair could not
   * be taken. Either way the last measurement is a failure, and `note` says
   * which one it was.
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

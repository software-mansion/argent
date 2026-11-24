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

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to deliver this input, so the foreground screen changed as
   * a side effect. Set only when true.
   */
  reactivated?: true;
  /**
   * Whether the focused field was read back holding the typed text. Absent
   * when no such check ran or it could not conclude.
   * - Android phone / tablet.
   * - iOS simulator, only when the field was empty before typing (a secure
   *   field: as many bullets). A capital iOS put at the start of a word still
   *   counts as the typed text.
   */
  verified?: boolean;
  /** Android: why `verified` is false or absent. Never quotes the field's contents. */
  note?: string;
  /** iOS simulator: set with `verified: false`, why the field may not hold what was typed. */
  warning?: string;
}

export type KeyboardVerification = Pick<KeyboardResult, "verified" | "note">;

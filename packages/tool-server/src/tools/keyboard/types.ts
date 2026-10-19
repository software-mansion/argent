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
   * Android phone / tablet only: whether the focused field was read back holding
   * the text. Absent when the check did not run or could not conclude.
   */
  verified?: boolean;
  /** Why `verified` is false or absent. Never quotes the field's contents. */
  note?: string;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to deliver this input, so the foreground screen changed as
   * a side effect. Set only when true.
   */
  reactivated?: true;
}

export type KeyboardVerification = Pick<KeyboardResult, "verified" | "note">;

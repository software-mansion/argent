export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` in ./index.ts, so a backend sees at most one of
   * the two. Not valid on TV targets.
   */
  key?: string;
  /** Number of times to press `key` (1–100, default 1). Rejected without `key` in ./index.ts. */
  repeat?: number;
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
   * iOS simulator only, and only when the focused field was empty before
   * typing: whether it now holds the typed text (a secure field: as many
   * bullets). A capital iOS put at the start of a word still counts as the
   * typed text. Absent when no such check ran.
   */
  verified?: boolean;
  /** Set with `verified: false`: why the field may not hold what was typed. */
  warning?: string;
}

export interface KeyboardParams {
  udid: string;
  /** Text to type character by character. */
  text?: string;
  /** Named key to press (enter, escape, arrow-*, f1–f12). Not valid on TV targets. */
  key?: string;
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
}

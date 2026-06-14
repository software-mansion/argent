/**
 * Shared contract for the focus-driven TV control services.
 *
 * Both backends implement the same `TvControlApi`:
 *   - `tv-control` (Apple TV simulators) drives the tvOS daemons over unix sockets.
 *   - `android-tv-control` (Android TV / leanback) drives `adb` (input keyevent,
 *     uiautomator, input text).
 *
 * Keeping the types here (rather than in `tv-control.ts`) lets the Android
 * backend depend on the contract without importing the iOS-only daemon-binary
 * resolvers from `@argent/native-devtools-ios`.
 */

export interface TvElement {
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  tapPoint?: { x: number; y: number };
  traits?: string[];
  value?: string;
  isFocused?: boolean;
}

export interface TvDescribeResponse {
  bundleId?: string;
  focused: TvElement | null;
  focusable: TvElement[];
  screenFrame?: { width: number; height: number };
}

export type TvDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "menu"
  | "home"
  | "playpause";

export const TV_DIRECTIONS: readonly TvDirection[] = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "menu",
  "home",
  "playpause",
];

export interface TvControlApi {
  /** Read the currently focused element plus all focusable elements. */
  describe(): Promise<TvDescribeResponse>;
  /** Read the full accessibility tree. */
  hierarchy(): Promise<unknown>;
  /** Jump focus directly to the element with the given label. */
  setFocus(label: string): Promise<{ ok: boolean; message: string }>;
  /** Send a directional / button event (D-pad on Android TV, Siri remote on tvOS). */
  navigate(direction: TvDirection): Promise<void>;
  /** Type a string into the focused field. */
  type(text: string): Promise<void>;
  /** Liveness check. */
  ping(): Promise<boolean>;
  /**
   * Force a fresh read path even if the current one is still alive. On tvOS this
   * respawns the ax daemon to drop a stale `primaryApp` cache after launch-app /
   * restart-app; on Android TV there is no cached daemon, so it is a no-op.
   */
  recycleAx(): Promise<void>;
}

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

// The full TV-remote button vocabulary, shared by every focus-driven backend
// (Apple TV daemon, Android TV adb, Vega inputd-cli). Member names match Vega's
// `RemoteButton` (utils/vega-input) exactly so the `tv-remote` tool can pass a
// button straight through to `navigate` with no mapping. The directional /
// select / back / menu / home subset is the focus-engine core; the media-
// transport and volume keys are honored where the backend supports them.
export type TvDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "back"
  | "home"
  | "menu"
  | "playPause"
  | "rewind"
  | "fastForward"
  | "next"
  | "previous"
  | "volumeUp"
  | "volumeDown"
  | "mute";

export interface TvControlApi {
  /** Read the currently focused element plus all focusable elements. */
  describe(): Promise<TvDescribeResponse>;
  /** Send a directional / button event (D-pad on Android TV, Siri remote on tvOS). */
  navigate(direction: TvDirection): Promise<void>;
  /** Type a string into the focused field. */
  type(text: string): Promise<void>;
  /**
   * Force a fresh read path even if the current one is still alive. On tvOS this
   * respawns the ax daemon to drop a stale `primaryApp` cache after launch-app /
   * restart-app; on Android TV there is no cached daemon, so it is a no-op.
   */
  recycleAx(): Promise<void>;
}

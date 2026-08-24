/**
 * Shared contract for the focus-driven TV control backends: `tv-control` (tvOS
 * daemons over unix sockets) and `android-tv-control` (`adb` input keyevent /
 * uiautomator / input text).
 *
 * The types live here rather than in `tv-control.ts` so the Android backend can
 * depend on the contract without importing the iOS-only daemon-binary resolvers
 * from `@argent/native-devtools-ios`.
 */

export interface TvElement {
  label?: string;
  traits?: string[];
  value?: string;
  isFocused?: boolean;
}

export interface TvDescribeResponse {
  bundleId?: string;
  focused: TvElement | null;
  focusable: TvElement[];
}

// Member names match `RemoteButton` (utils/vega-input) exactly, so `tv-remote`
// passes a button straight to `navigate` with no mapping. A backend that can't
// honor a key (tvOS simulator: media-transport / volume) rejects it up front.
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
  describe(): Promise<TvDescribeResponse>;
  /** Press a remote button (D-pad on Android TV, Siri remote on tvOS). */
  navigate(direction: TvDirection): Promise<void>;
  /** Type a string into the focused field. */
  type(text: string): Promise<void>;
  /**
   * tvOS: respawn the ax daemon, dropping a `primaryApp` cache left stale by
   * launch-app / restart-app. Android TV: no cached daemon, so a no-op.
   */
  recycleAx(): Promise<void>;
}

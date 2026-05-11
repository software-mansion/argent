import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
}

export interface LaunchAppResult {
  launched: boolean;
  bundleId: string;
}

// iOS gets the native-devtools service so launch-app can warm DYLD env before
// the app starts. Android's `services()` returns `{}` so its handler typechecks
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppAndroidServices = Record<string, never>;

import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  activity?: string;
}

export interface RestartAppResult {
  restarted: boolean;
  bundleId: string;
}

// iOS gets the native-devtools service so restart-app can refresh the DYLD env
// before the relaunch. Android's `services()` returns `{}` so its handler types
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppAndroidServices = Record<string, never>;

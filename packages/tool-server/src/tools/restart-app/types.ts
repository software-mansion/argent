import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
  /** Apple simulator-only: appended to the simctl launch argv after the bundle id. */
  launchArgs?: string[];
}

export type RestartAppResult =
  | { restarted: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;

// iOS gets the native-devtools service so restart-app can refresh the DYLD env
// before the relaunch. Android's `services()` returns `{}` so its handler types
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppAndroidServices = Record<string, never>;
export type RestartAppVegaServices = Record<string, never>;

import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
}

export type LaunchAppResult =
  | {
      launched: boolean;
      bundleId: string;
      /**
       * Android only: set when the launch overran Android's wait window and was
       * confirmed by checking the app's process instead. The app is up but may not
       * be interactive yet.
       */
      note?: string;
    }
  | NativeDevtoolsInitFailedResult;

// iOS gets the native-devtools service so launch-app can warm DYLD env before
// the app starts. Android's `services()` returns `{}` so its handler typechecks
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppAndroidServices = Record<string, never>;
export type LaunchAppVegaServices = Record<string, never>;

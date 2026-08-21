import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  activity?: string;
}

export type RestartAppResult =
  | {
      restarted: boolean;
      bundleId: string;
      /**
       * Android only: set when the launch overran Android's wait window and was
       * confirmed by checking the app's process instead. The app is up but may not
       * be interactive yet.
       */
      note?: string;
    }
  | NativeDevtoolsInitFailedResult;

// iOS gets the native-devtools service so restart-app can refresh the DYLD env
// before the relaunch. Android's `services()` returns `{}` so its handler types
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppAndroidServices = Record<string, never>;
export type RestartAppVegaServices = Record<string, never>;

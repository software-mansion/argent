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
  | { launched: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;

// iOS gets the native-devtools service so launch-app can warm DYLD env before
// the app starts. Vega's `services()` returns `{}`, so its handler typechecks
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
// Android takes the same empty shape, spelled inline in `platforms/android.ts`
// because no second file names it.
export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;

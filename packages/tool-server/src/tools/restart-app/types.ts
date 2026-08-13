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
  | { restarted: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;

// iOS gets the native-devtools service so restart-app can refresh the DYLD env
// before the relaunch. Vega's `services()` returns `{}`, so its handler types
// against an empty shape — `dispatchByPlatform` keeps the two generics separate.
// Android takes the same empty shape, spelled inline in `platforms/android.ts`
// because no second file names it.
export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppVegaServices = Record<string, never>;

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
// against the empty shape below - `dispatchByPlatform` keeps the two generics
// separate. Android's `services()` returns `{}` too, but its handler is NOT
// typed against this shape: it takes `Record<string, unknown>`, which is wider
// and is written twice, in `platforms/android.ts` and in the
// `dispatchByPlatform` generics in `index.ts`. The two have to agree, so
// narrowing one alone does not compile.
export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppVegaServices = Record<string, never>;

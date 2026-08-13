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
// against the empty shape below - `dispatchByPlatform` keeps the two generics
// separate. Android's `services()` returns `{}` too, but its handler is NOT
// typed against this shape: it takes `Record<string, unknown>`, which is wider
// and is written twice, in `platforms/android.ts` and in the
// `dispatchByPlatform` generics in `index.ts`. The two have to agree, so
// narrowing one alone does not compile - `Record<string, never>` on the impl
// gives TS2322 at `index.ts`, on the `android:` property.
export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;

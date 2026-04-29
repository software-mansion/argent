import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";

// Shared contract for restart-app's platform branches. Lives outside
// `ios.ts` / `android.ts` so neither owns the cross-platform types.

export interface RestartAppParams {
  udid: string;
  bundleId: string;
}

export interface RestartAppResult {
  restarted: boolean;
  bundleId: string;
}

// Even though only iOS reads `nativeDevtools` (Android's `services()` returns
// `{}`), `dispatchByPlatform` requires both branches share a Services generic.
// Declaring the iOS-shaped service here lets the Android branch type itself
// against the same shape and ignore the field at runtime.
export interface RestartAppServices {
  nativeDevtools: NativeDevtoolsApi;
}

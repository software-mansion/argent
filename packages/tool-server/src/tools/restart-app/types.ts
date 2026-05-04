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

// Even though only iOS reads `nativeDevtools` (Android's `services()` returns
// `{}`), `dispatchByPlatform` requires both branches share a Services generic.
// Declaring the iOS-shaped service here lets the Android branch type against
// the same shape and ignore the field at runtime.
export interface RestartAppServices {
  nativeDevtools: NativeDevtoolsApi;
}

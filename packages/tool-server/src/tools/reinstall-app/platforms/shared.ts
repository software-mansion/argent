// Shared contract for reinstall-app's platform branches. Lives outside
// `ios.ts` / `android.ts` because it isn't platform-specific — both
// branches consume the same Params, return the same Result, and declare
// the same (empty) Services.

export interface ReinstallAppParams {
  udid: string;
  bundleId: string;
  appPath: string;
}

export interface ReinstallAppResult {
  reinstalled: boolean;
  bundleId: string;
}

export type ReinstallAppServices = Record<string, never>;

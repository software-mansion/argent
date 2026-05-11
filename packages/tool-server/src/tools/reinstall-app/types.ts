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

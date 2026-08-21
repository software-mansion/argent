export interface InstallAppParams {
  udid: string;
  url: string;
  headers?: Record<string, string>;
}

export interface InstallAppResult {
  installed: true;
  bundleId: string;
}

export type InstallAppServices = Record<string, never>;

export interface OpenUrlParams {
  udid: string;
  url: string;
  /** Physical iOS only. The app that receives the URL. */
  bundleId?: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
  /** Deep-link caveat: set only for http(s) URLs on iOS/Android, never for custom schemes or Chromium. */
  note?: string;
}

export type OpenUrlServices = Record<string, never>;

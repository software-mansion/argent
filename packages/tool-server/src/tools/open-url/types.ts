export interface OpenUrlParams {
  udid: string;
  url: string;
  /** Physical iOS only. The app that receives the URL. */
  bundleId?: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
  /**
   * Caveat: set for http(s) URLs on iOS/Android and for every URL on HarmonyOS;
   * never on Chromium.
   */
  note?: string;
}

export type OpenUrlServices = Record<string, never>;

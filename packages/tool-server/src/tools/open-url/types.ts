export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
  /**
   * Present when the URL was a web URL (http/https) opened on a native device:
   * a caveat that it may have opened in the browser rather than deep-linked into
   * a native app. Absent for custom schemes and for Chromium navigations.
   */
  note?: string;
}

export type OpenUrlServices = Record<string, never>;

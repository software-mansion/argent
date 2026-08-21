export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
  /**
   * What `opened: true` leaves unsaid. On iOS and Android it is the web-URL
   * caveat — an http/https link may have opened in the browser rather than
   * deep-linked into a native app — and a custom scheme carries none. On
   * HarmonyOS every URL carries one, since `aa start -U` reports success for any
   * URI the system accepts (see that platform's impl). Absent for Chromium
   * navigations, which land on the page they were given.
   */
  note?: string;
}

export type OpenUrlServices = Record<string, never>;

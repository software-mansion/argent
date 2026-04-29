// Shared contract for open-url's platform branches. Lives outside
// `ios.ts` / `android.ts` so neither owns the cross-platform types.

export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
}

export type OpenUrlServices = Record<string, never>;

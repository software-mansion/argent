export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
}

export type OpenUrlServices = Record<string, never>;

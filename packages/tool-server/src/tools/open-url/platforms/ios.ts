import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const execFileAsync = promisify(execFile);

export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
}

export type OpenUrlServices = Record<string, never>;

export const iosImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    return { opened: true, url: params.url };
  },
};

import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export async function openUrlIos(
  _services: OpenUrlServices,
  params: OpenUrlParams
): Promise<OpenUrlResult> {
  await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
  return { opened: true, url: params.url };
}

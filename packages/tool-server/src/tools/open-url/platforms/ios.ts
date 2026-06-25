import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    try {
      await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    } catch (err) {
      throw new FailureError(
        `Failed to open URL on iOS simulator ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_OPEN_URL_FAILED,
          failure_stage: "ios_open_url_simctl_openurl",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { opened: true, url: params.url };
  },
};

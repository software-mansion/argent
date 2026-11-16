import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../../../utils/simctl-config";
import { firstSimulatorPoll } from "../../../utils/simulator-watcher";
import { XcodeFirstLaunchPendingError } from "../../../utils/dependency-errors";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    // The URL can cold-launch its app, which must not beat injection.
    await firstSimulatorPoll();
    try {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(params.udid, ["openurl", params.udid, params.url]),
        { timeout: 30_000, killSignal: SIMCTL_KILL_SIGNAL }
      );
    } catch (err) {
      // Its message says what to do, and a flow step reports only the thrown message.
      if (err instanceof XcodeFirstLaunchPendingError) throw err;
      const timedOut = (err as { killed?: boolean }).killed === true;
      throw new FailureError(
        timedOut
          ? `Opening the URL on iOS simulator ${params.udid} did not finish within 30s.`
          : `Failed to open URL on iOS simulator ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_OPEN_URL_FAILED,
          failure_stage: "ios_open_url_simctl_openurl",
          failure_area: "tool_server",
          error_kind: timedOut ? "timeout" : "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { opened: true, url: params.url, note: httpDeepLinkNote(params.url) };
  },
};

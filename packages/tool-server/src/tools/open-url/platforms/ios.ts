import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { assertPhysicalIosEnabled } from "../../../blueprints/simulator-server";
import { subprocessOutputTail } from "../../../utils/format-error";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    if (device.kind === "device") {
      // Physical iPhones open URLs through devicectl rather than simctl. Like
      // every devicectl-backed tool, this has to enforce the opt-in itself,
      // since no simulator-server ref is built on this path to run the gate.
      assertPhysicalIosEnabled();
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "process",
          "openURL",
          "--device",
          params.udid,
          params.url,
        ]);
      } catch (err) {
        const detail = subprocessOutputTail(err);
        throw new FailureError(
          `Failed to open URL on physical iOS device ${params.udid}.` +
            (detail ? ` devicectl: ${detail}.` : ""),
          {
            error_code: FAILURE_CODES.IOS_OPEN_URL_FAILED,
            failure_stage: "ios_open_url_devicectl_openurl",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_devicectl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { opened: true, url: params.url, note: httpDeepLinkNote(params.url) };
    }
    try {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(params.udid, ["openurl", params.udid, params.url])
      );
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
    return { opened: true, url: params.url, note: httpDeepLinkNote(params.url) };
  },
};

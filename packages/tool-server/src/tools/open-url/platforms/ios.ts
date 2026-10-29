import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type Registry,
} from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../../blueprints/native-devtools";
import { externalClaimForAnyId } from "../../../utils/external-devices";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

const execFileAsync = promisify(execFile);

export function makeIosImpl(
  registry: Registry
): PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      // The URL can cold-launch its app, so arm injection first, as launch-app
      // does (and skips it on a provider's device for the same reason). Only
      // the native-* tools miss it, so it never fails the open.
      if (!externalClaimForAnyId(device.id)) {
        const ndRef = nativeDevtoolsRef(device);
        await registry
          .resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options)
          .then((nativeDevtools) => nativeDevtools.ensureEnvReady())
          .catch(() => {});
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
}

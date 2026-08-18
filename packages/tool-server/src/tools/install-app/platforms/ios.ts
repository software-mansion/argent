import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { prepareIosRemoteArtifact } from "../artifact";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, _device, options) => {
    const artifact = await prepareIosRemoteArtifact(params, options?.signal);
    try {
      await execFileAsync("xcrun", ["simctl", "install", params.udid, artifact.installablePath], {
        timeout: 180_000,
        signal: options?.signal,
      });
      return { installed: true, bundleId: artifact.bundleId };
    } catch (error) {
      throw new FailureError(
        `Failed to install downloaded iOS app bundle on ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_INSTALL_FAILED,
          failure_stage: "ios_install_app_from_url",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(error, "xcrun_simctl"),
        },
        { cause: error instanceof Error ? error : new Error(String(error)) }
      );
    } finally {
      await artifact.cleanup();
    }
  },
};

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { assertPhysicalIosEnabled } from "../../../blueprints/simulator-server";
import { subprocessOutputTail } from "../../../utils/format-error";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { deviceSetForUdid, simctlPrefix } from "../../../utils/ios-device-sets";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);

    if (device.kind === "device") {
      // Physical iPhones install through devicectl rather than simctl. Like
      // every devicectl-backed tool, this enforces the opt-in itself, since no
      // simulator-server ref is built on this path to run the gate.
      assertPhysicalIosEnabled();
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "uninstall",
          "app",
          "--device",
          udid,
          bundleId,
        ]);
      } catch {
        // App may not be installed — continue to install
      }
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "install",
          "app",
          "--device",
          udid,
          absolute,
        ]);
      } catch (err) {
        // devicectl's own diagnosis comes first: it distinguishes a locked
        // device, a missing app and a signing failure, which need different
        // fixes, and nothing else carries it to the caller (the metadata below
        // records only exit code / signal). The signing hint follows as the
        // likeliest cause rather than as the verdict — devicectl buries it
        // several lines in, and it is wrong for every other failure.
        const detail = subprocessOutputTail(err);
        throw new FailureError(
          `Failed to install ${bundleId} on physical iOS device ${udid}.` +
            (detail ? ` devicectl: ${detail}.` : "") +
            ` Most often the bundle is not built for iOS (a simulator .app) or its provisioning profile does not list this device.`,
          {
            error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
            failure_stage: "ios_reinstall_app_devicectl_install",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_devicectl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { reinstalled: true, bundleId };
    }

    // Simulator path: address the device set that owns this UDID.
    const prefix = simctlPrefix(await deviceSetForUdid(udid));
    try {
      await execFileAsync("xcrun", [...prefix, "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    try {
      await execFileAsync("xcrun", [...prefix, "install", udid, absolute]);
    } catch (err) {
      throw new FailureError(
        `Failed to install iOS app bundle on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
          failure_stage: "ios_reinstall_app_simctl_install",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { reinstalled: true, bundleId };
  },
};

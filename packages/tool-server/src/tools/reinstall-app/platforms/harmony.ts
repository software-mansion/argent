import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { runHdc } from "../../../utils/harmony-hdc";
import { assertHap } from "../validate-app";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

// `hdc install` / `uninstall` exit 0 whatever happened; the result is the `msg:` line.
const INSTALLED = "msg:install bundle successfully.";
const UNINSTALLED = "msg:uninstall bundle successfully.";
const NOT_INSTALLED = "code:9568386";

/** Only "not installed" is tolerated on the uninstall: an app left installed would not be wiped. */
export const harmonyImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    const { bundleId, appPath } = params;
    const connectKey = harmonyConnectKey(device.id);
    const absolute = resolvePath(appPath);
    await assertHap(absolute, bundleId);

    const uninstall = await runHdc(["-t", connectKey, "uninstall", bundleId], 60_000);
    if (!uninstall.stdout.includes(UNINSTALLED) && !uninstall.stdout.includes(NOT_INSTALLED)) {
      throw reinstallFailure("uninstall", connectKey, bundleId, uninstall);
    }

    const install = await runHdc(["-t", connectKey, "install", absolute], 180_000);
    if (!install.stdout.includes(INSTALLED)) {
      throw reinstallFailure("install", connectKey, bundleId, install);
    }
    return { reinstalled: true, bundleId };
  },
};

function reinstallFailure(
  step: "uninstall" | "install",
  connectKey: string,
  bundleId: string,
  result: { stdout: string; stderr: string }
): FailureError {
  const detail =
    /msg:(.*)$/m.exec(result.stdout)?.[1]?.trim() ??
    (`${result.stdout}\n${result.stderr}`.trim() || "hdc printed nothing");
  return new FailureError(
    `hdc ${step} of '${bundleId}' failed on HarmonyOS device '${connectKey}': ${detail}`,
    {
      error_code: FAILURE_CODES.HARMONY_REINSTALL_FAILED,
      failure_stage: `harmony_reinstall_${step}`,
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "hdc",
    }
  );
}

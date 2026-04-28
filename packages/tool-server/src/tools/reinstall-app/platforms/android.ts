import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "./ios";

export const androidImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    const args = ["-s", udid, "install", "-r"];
    if (params.allowDowngrade) args.push("-d");
    if (params.grantPermissions) args.push("-g");
    args.push(absolute);
    const { stdout, stderr } = await runAdb(args, { timeoutMs: 180_000 });
    const output = `${stdout}\n${stderr}`;
    if (!/Success/i.test(output)) {
      throw new Error(`adb install failed: ${output.trim()}`);
    }
    return { reinstalled: true, bundleId };
  },
};

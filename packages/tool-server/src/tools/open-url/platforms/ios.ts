import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    if (device.kind === "device") {
      // CoreDevice/devicectl has no deep-link/open-url surface for physical
      // iOS; only screenshot, gesture-tap, gesture-swipe, button, and launch-app
      // are supported there today.
      throw new Error("open-url is not supported on physical iOS devices.");
    }
    await execFileAsync("xcrun", ["simctl", "openurl", params.udid, params.url]);
    return { opened: true, url: params.url };
  },
};

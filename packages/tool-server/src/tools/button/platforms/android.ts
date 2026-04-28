import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ButtonParams, ButtonResult, ButtonServices } from "./ios";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Android uses the same `simulator-server` channel as iOS — see comment in
// `gesture-tap/platforms/android.ts` for context. The Android backend maps
// each button name to the corresponding KEYCODE internally.
export const androidImpl: PlatformImpl<ButtonServices, ButtonParams, ButtonResult> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    sendCommand(api, {
      cmd: "button",
      direction: "Down",
      button: params.button,
    });
    await sleep(50);
    sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
    return { pressed: params.button };
  },
};

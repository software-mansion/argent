import {
  listedWindows,
  MACOS_NO_WINDOW_MESSAGE,
  type MacosAppApi,
} from "../../../blueprints/macos-app";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { assertLaunchTargetsDevice } from "../../../utils/macos-apps";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Makes sure the app of the device runs with the argent library loaded, in
 * the background. An app argent already runs is left as it is; a copy that
 * runs without the library is never quit here.
 */
export const macosImpl: PlatformImpl<{ macosApp: MacosAppApi }, LaunchAppParams, LaunchAppResult> =
  {
    handler: async (services, params, device) => {
      const bundleId = assertLaunchTargetsDevice(params.bundleId, device);
      // No `args`: a stopped app starts again with the arguments of its last start.
      const { args, alreadyRunning, note } = await services.macosApp.launch();
      if (!alreadyRunning) return { launched: true, bundleId, args, ...(note ? { note } : {}) };
      // A restart would lose the state of an app that only closed its last window.
      const windows = await services.macosApp.call("Window.list").then(listedWindows, () => null);
      const shown =
        windows && !windows.some((w) => w.isReference === true)
          ? `The app was already running with the argent library. ${MACOS_NO_WINDOW_MESSAGE}`
          : "The app was already running with the argent library; use restart-app for a new process.";
      return { launched: true, bundleId, args, note: shown };
    },
  };

import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import {
  isSessionOnlySystemUi,
  setCurrentIosDeviceApp,
} from "../../../utils/ios-device/app-session";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

/** The default receiver for web URLs. */
const SAFARI_BUNDLE_ID = "com.apple.mobilesafari";

/**
 * Resolve which app receives the URL. devicectl passes a URL to one named app
 * at launch and cannot resolve a scheme's handler system-wide, so web URLs
 * default to Safari and every other scheme must name its receiver.
 */
function resolveReceivingBundleId(params: OpenUrlParams): string {
  if (params.bundleId) {
    return params.bundleId;
  }

  if (/^https?:/i.test(params.url)) {
    return SAFARI_BUNDLE_ID;
  }

  throw new InvalidToolInputError(
    "devicectl cannot resolve which app handles this URL scheme on a physical device. " +
      "Pass bundleId naming the app that receives the URL, or use launch-app to open the app directly."
  );
}

/**
 * Open a URL on a physical iOS device. devicectl launches the receiving app
 * with the URL as its launch payload, so the launch fronts that app and it
 * becomes the app under automation.
 */
export const iosDeviceImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const bundleId = resolveReceivingBundleId(params);

    // Reject system UI before contacting the device. It cannot receive a payload URL launch.
    if (isSessionOnlySystemUi(bundleId)) {
      throw new InvalidToolInputError(
        `${bundleId} is system UI and cannot receive a URL. Pass the app that handles this URL instead.`
      );
    }

    await ensureDeviceReady(params.udid);
    await launchApp(params.udid, bundleId, { payloadUrl: params.url });

    setCurrentIosDeviceApp(params.udid, bundleId);

    // A web URL delivered to Safari keeps the deep-link ambiguity the note
    // describes. A URL delivered to an explicitly named app does not.
    const note = bundleId === SAFARI_BUNDLE_ID ? httpDeepLinkNote(params.url) : undefined;

    return {
      opened: true,
      url: params.url,
      ...(note ? { note } : {}),
    };
  },
};

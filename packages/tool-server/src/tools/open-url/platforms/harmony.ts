import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { openHarmonyUrl } from "../../../utils/harmony-apps";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

/**
 * `aa start -U` reports success for anything the system accepts: a web URL can
 * leave the screen unchanged, and `tel:`/`mailto:` can leave a chooser up. So
 * every URL carries the caveat.
 */
const HARMONY_OPEN_CAVEAT =
  "On HarmonyOS specifically, `aa start -U` reports success whenever the system accepts the URI, " +
  "so `opened: true` does not mean an app opened it: a web URL can leave the foreground app on " +
  "screen unchanged, and a scheme the system hands to its app selector (measured with `tel:` and " +
  '`mailto:`) leaves a chooser covering the screen — one listing handlers, or a modal "No options ' +
  'to open with" when none claims it. Confirm ' +
  "with describe or screenshot, and dismiss any chooser, before treating the link as followed.";

export const harmonyImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    await openHarmonyUrl(harmonyConnectKey(device.id), params.url);
    const shared = httpDeepLinkNote(params.url);
    return {
      opened: true,
      url: params.url,
      note: shared ? `${shared} ${HARMONY_OPEN_CAVEAT}` : HARMONY_OPEN_CAVEAT,
    };
  },
};

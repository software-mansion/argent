import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { openHarmonyUrl } from "../../../utils/harmony-apps";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

/**
 * `aa start -U <uri>` is HarmonyOS' implicit open — the system picks the
 * handler, which is exactly what this tool wants (and the one place implicit
 * start is the right verb; see `harmony-apps`).
 *
 * A scheme **no ability claims at all** is caught: `aa` prints `10103101 Failed
 * to find a matching application for implicit launch`, which `openHarmonyUrl`
 * turns into a throw.
 *
 * What the system does accept is not caught, and cannot be. Measured on
 * HarmonyOS 6.0.1, all printing `start ability successfully.`:
 * `https://example.com` leaves the foreground app unchanged, and `tel:` /
 * `mailto:` hand off to the system app selector, which puts up a modal "No
 * options to open with" that covers the screen until it is dismissed. Nothing in
 * `aa`'s output separates any of those from a link that was really followed, so
 * the caveat rides on every URL rather than on web ones alone: `opened: true`
 * here means "the system accepted the URI", which on this platform is weaker
 * than it sounds.
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

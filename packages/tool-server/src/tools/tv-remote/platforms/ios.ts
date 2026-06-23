import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RemoteButton } from "../../../utils/vega-input";
import type { TvRemoteParams, TvRemoteResult } from "../types";
import { pressFocusRemote } from "./focus-remote";

// Media-transport / volume keys are inert on the tvOS *simulator*: its HID stack
// honors only the USB keyboard page (0x07, the D-pad/select/back/menu/home core)
// and the Indigo button channel — Consumer Control (0x0C) events are silently
// dropped, so injecting them reports success while nothing happens. Reject them
// up front rather than lie. (playPause survives — it rides the keyboard Space
// fallback in the daemon. These keys DO work on Android TV via adb keyevents.)
const APPLE_TV_UNSUPPORTED: ReadonlySet<RemoteButton> = new Set([
  "rewind",
  "fastForward",
  "next",
  "previous",
  "volumeUp",
  "volumeDown",
  "mute",
]);

// Apple TV (tvOS) simulator. Classifies as platform "ios" by UDID shape; the
// tv-control daemons inject Siri-remote HID events. Delegates to the shared
// focus-driven remote (resolveTvApi rejects a non-tvOS simulator).
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> {
  return {
    handler: (_services, params, device) =>
      pressFocusRemote(registry, device, params, APPLE_TV_UNSUPPORTED),
  };
}

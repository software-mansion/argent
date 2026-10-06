import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RemoteButton } from "../../../utils/vega-input";
import type { TvRemoteParams, TvRemoteResult } from "../types";
import { pressFocusRemote } from "./focus-remote";

// The tvOS simulator's HID stack silently drops media-transport / volume keys:
// injecting them reports success while nothing happens, so reject them up front
// rather than lie. They do work on Android TV.
const APPLE_TV_UNSUPPORTED: ReadonlySet<RemoteButton> = new Set([
  "rewind",
  "fastForward",
  "next",
  "previous",
  "volumeUp",
  "volumeDown",
  "mute",
]);

// Apple TV: tvOS UDIDs classify as platform "ios" by shape, so this branch takes
// them and `resolveTvApi` rejects the non-tvOS ones.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> {
  return {
    handler: (_services, params, device, options) =>
      pressFocusRemote(registry, device, params, APPLE_TV_UNSUPPORTED, options),
  };
}

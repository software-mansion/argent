import type { Platform } from "@argent/registry";
import { TV_DIRECTIONS } from "../../blueprints/tv-control-types";

// Hardware buttons that physically exist on a phone/tablet, plus the TV-remote
// buttons (the focus D-pad + select/menu/home/playpause). The zod enum is the
// union of every target's buttons — a flat enum can't express which apply to
// which target — so each platform branch refines it against the resolved device.
export const HARDWARE_BUTTONS = [
  "home",
  "back",
  "power",
  "volumeUp",
  "volumeDown",
  "appSwitch",
  "actionButton",
] as const;

export const ALL_BUTTONS = [...HARDWARE_BUTTONS, ...TV_DIRECTIONS] as const;

export type Button = (typeof ALL_BUTTONS)[number];

export interface ButtonParams {
  udid: string;
  button: Button;
}

export interface ButtonResult {
  pressed: string;
}

/**
 * Hardware buttons that physically exist per platform. iOS has no `back`,
 * Android has no `actionButton`. Validation lives at the tool layer because the
 * simulator-server transport is fire-and-forget (see `sendCommand`) and cannot
 * report a backend rejection — an unsupported button would otherwise be a
 * silent no-op that the tool still reports as a successful `{ pressed }`.
 */
export const HARDWARE_BY_PLATFORM: Record<Platform, ReadonlySet<Button>> = {
  ios: new Set(["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"]),
  android: new Set(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch"]),
  // Chromium apps have no hardware buttons; the capability gate already
  // excludes them, the empty set keeps the lookup total if one slips through.
  chromium: new Set([]),
};

/** The TV-remote buttons, valid only on a `runtimeKind: "tv"` target. */
export const TV_BUTTONS: ReadonlySet<Button> = new Set(TV_DIRECTIONS);

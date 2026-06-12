/**
 * Vega TV-remote button vocabulary (NAMES only).
 *
 * The host (argent) only needs the button *names* for tool schemas — it passes
 * them straight to the `vega-fast-cli` host binary, which owns the name → Linux
 * `KEY_` mapping and the on-device injection. (Keyboard `key` names are validated
 * by the CLI too, so there's no separate list here.)
 */
export const REMOTE_BUTTONS = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "back",
  "home",
  "menu",
  "playPause",
  "rewind",
  "fastForward",
  "next",
  "previous",
  "volumeUp",
  "volumeDown",
  "mute",
] as const;

export type RemoteButton = (typeof REMOTE_BUTTONS)[number];

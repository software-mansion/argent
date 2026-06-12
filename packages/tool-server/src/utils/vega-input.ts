/**
 * Vega input keycode maps.
 *
 * Input is injected on-device by the agent's held-open `inputd-cli` REPL (see
 * `vega-transport` / `native-devtools-vega`). `inputd-cli button_press`/
 * `send_text` go through the `inputmgr-key-injection` device, producing real
 * remote/navigation events the Cartesian focus engine acts on — unlike QMP
 * `send-key`, which injects into the QEMU virtual *keyboard* (`qwerty2`) and is
 * delivered as a character key the focus engine ignores. These maps translate
 * each tool's vocabulary (RemoteButton / named key) into the KEY_ names the
 * agent forwards to `inputd-cli`.
 */

// TV-remote button → Linux input KEY_ name accepted by `inputd-cli button_press`.
// Names verified against a known-good Vega navigation script: select is
// KEY_ENTER (KEY_SELECT is a no-op), home is KEY_HOME (not KEY_HOMEPAGE).
export const REMOTE_KEYCODES = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  select: "KEY_ENTER",
  back: "KEY_BACK",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  playPause: "KEY_PLAYPAUSE",
  rewind: "KEY_REWIND",
  fastForward: "KEY_FASTFORWARD",
  next: "KEY_NEXTSONG",
  previous: "KEY_PREVIOUSSONG",
  volumeUp: "KEY_VOLUMEUP",
  volumeDown: "KEY_VOLUMEDOWN",
  mute: "KEY_MUTE",
} as const;

export type RemoteButton = keyof typeof REMOTE_KEYCODES;

// Named keys (the keyboard tool's `key` vocabulary) → KEY_ names.
export const NAMED_KEYCODES: Record<string, string> = {
  enter: "KEY_ENTER",
  escape: "KEY_BACK",
  backspace: "KEY_BACKSPACE",
  delete: "KEY_DELETE",
  tab: "KEY_TAB",
  space: "KEY_SPACE",
  "arrow-up": "KEY_UP",
  "arrow-down": "KEY_DOWN",
  "arrow-left": "KEY_LEFT",
  "arrow-right": "KEY_RIGHT",
  // Vega names function keys KEY_FN_F<n> (not KEY_F<n>); F1–F11 exist.
  ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i + 1}`, `KEY_FN_F${i + 1}`])),
};

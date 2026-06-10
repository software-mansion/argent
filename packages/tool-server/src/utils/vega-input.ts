import { vegaDevice, vegaShellQuote } from "./vega-cli";

/**
 * Vega input injection via the on-device input daemon CLI (`inputd-cli`).
 *
 * This is the authoritative path. QMP `send-key` injects into the QEMU virtual
 * *keyboard* (`qwerty2`), which Vega delivers to the app as a character key
 * event that the Cartesian focus engine ignores — so D-pad navigation never
 * moves. `inputd-cli button_press`/`send_text` inject through the
 * `inputmgr-key-injection` device, producing real remote/navigation events the
 * focus engine acts on. Reached over `vega device run-cmd`.
 */

// TV-remote button → Linux input KEY_ name accepted by `inputd-cli button_press`.
export const REMOTE_KEYCODES = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  select: "KEY_SELECT",
  back: "KEY_BACK",
  home: "KEY_HOMEPAGE",
  menu: "KEY_MENU",
  playPause: "KEY_PLAYPAUSE",
  rewind: "KEY_REWIND",
  fastForward: "KEY_FASTFORWARD",
} as const;

export type RemoteButton = keyof typeof REMOTE_KEYCODES;

/**
 * Press a remote button `repeat` times. This build's `inputd-cli` rejects the
 * documented `[repeat]` positional, so we issue one `button_press <key>` per
 * press, `;`-joined into a single on-device shell command (one `run-cmd` round
 * trip). KEY_ names are from a fixed map, so there is no shell-injection
 * surface. Returns the count.
 */
export async function pressRemoteButton(
  serial: string,
  button: RemoteButton,
  opts: { repeat?: number } = {}
): Promise<number> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const key = REMOTE_KEYCODES[button];
  const cmd = Array.from({ length: repeat }, () => `inputd-cli button_press ${key}`).join("; ");
  await vegaDevice(serial, ["run-cmd", "-c", cmd], { timeoutMs: 30_000 });
  return repeat;
}

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
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `KEY_F${i + 1}`])),
};

/** Press a single named key (enter/arrows/f1…/back) via `inputd-cli button_press`. */
export async function pressNamedKey(serial: string, name: string): Promise<void> {
  const key = NAMED_KEYCODES[name.toLowerCase()];
  if (!key) {
    throw new Error(
      `Unknown key "${name}" for Vega. Supported: ${Object.keys(NAMED_KEYCODES).join(", ")}`
    );
  }
  await vegaDevice(serial, ["run-cmd", "-c", `inputd-cli button_press ${key}`], {
    timeoutMs: 20_000,
  });
}

/**
 * Type free text into the focused field via `inputd-cli send_text`. The text is
 * single-quoted for the on-device shell (vegaShellQuote); `run-cmd -c` reaches
 * the device over execFile (no host shell), so the quoting is applied exactly
 * once. Returns the number of characters sent.
 */
export async function sendText(serial: string, text: string): Promise<number> {
  await vegaDevice(serial, ["run-cmd", "-c", `inputd-cli send_text ${vegaShellQuote(text)}`], {
    timeoutMs: 30_000,
  });
  return [...text].length;
}

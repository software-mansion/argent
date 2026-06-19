/**
 * Vega input injection — host-side over `adb`, no bundled binary.
 *
 * Input is injected on-device by `inputd-cli`, a stock Vega tool, over
 * `adb shell` against the single connected VVD (serial `emulator-<consolePort>`,
 * the same path the screenshot tool uses). `inputd-cli button_press KEY_*` /
 * `send_text` drive the `inputmgr-key-injection` device, producing real
 * remote/navigation events the Cartesian focus engine acts on — unlike QMP
 * `send-key`, which injects into the QEMU virtual *keyboard* (`qwerty2`) and is
 * delivered as a character key the focus engine ignores.
 *
 * This is a separate, lower-level channel from the automation toolkit, and is
 * the one proven to work on the CI VVD (where the toolkit may never attach). It
 * replaces the former `vega-fast-cli` host binary, removing the per-host
 * arch/glibc build entirely (all that's left is `adb`, which argent already
 * ships for Android).
 */
import { adbShell, shellQuote } from "./adb";
import { emulatorSerial } from "./vega-automation";

// TV-remote button → Linux input KEY_ name accepted by `inputd-cli button_press`.
// Codes verified against the VVD remote skin keymap (vmtools/agent/skins/
// tv-remote/layout) and on-device: select is KEY_ENTER (KEY_SELECT is a no-op),
// home is KEY_HOMEPAGE (KEY_HOME is inert).
export const REMOTE_KEYCODES = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  select: "KEY_ENTER",
  back: "KEY_BACK",
  home: "KEY_HOMEPAGE",
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

// The `tv-remote` tool's button vocabulary (schema enum). Key order is the
// insertion order above (D-pad first), which reads naturally in tool help.
export const REMOTE_BUTTONS = Object.keys(REMOTE_KEYCODES) as RemoteButton[];

// Named keys (the keyboard tool's `key` vocabulary) → KEY_ names.
export const NAMED_KEYCODES: Record<string, string> = {
  "enter": "KEY_ENTER",
  "escape": "KEY_BACK",
  "backspace": "KEY_BACKSPACE",
  "delete": "KEY_DELETE",
  "tab": "KEY_TAB",
  "space": "KEY_SPACE",
  "arrow-up": "KEY_UP",
  "arrow-down": "KEY_DOWN",
  "arrow-left": "KEY_LEFT",
  "arrow-right": "KEY_RIGHT",
  // Vega names function keys KEY_FN_F<n> (not KEY_F<n>); F1–F11 exist.
  ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i + 1}`, `KEY_FN_F${i + 1}`])),
};

// Settle between presses so the focus engine keeps up (CI's llvmpipe render is
// slow); matches the cadence of the known-good Vega navigation script.
const SETTLE_BETWEEN_PRESSES_S = 0.3;

/** Map a path of buttons to the `inputd-cli` KEY_ codes (pure; unit-tested). */
export function remoteButtonsToKeycodes(buttons: RemoteButton[]): string[] {
  return buttons.map((b) => REMOTE_KEYCODES[b]);
}

/**
 * Run one or more `inputd-cli` subcommands on the VVD in a single `adb shell`
 * round-trip, gated on an input-channel liveness probe.
 *
 * `inputd-cli get_screen_size` prints "<W> x <H>" only when the input daemon is
 * reachable; we run it first and require that shape, so a dead channel fails
 * loudly instead of silently dropping every press (the exact no-op the old
 * vega-fast-cli path degraded to on the CI VVD). The subcommands themselves are
 * best-effort (`|| true`, output discarded) and settle between, mirroring the
 * proven navigation script.
 *
 * TODO: `get_screen_size` is a *basic* inputd-cli command available even when
 * the VVD's developer mode is off, whereas `button_press` / `send_text` require
 * it. So the probe passes but every press silently no-ops on a dev-mode-off VVD.
 * Gate on a dev-mode-only command (or check `vsm developer-mode`) so that case
 * fails loudly too.
 *
 * Callers must pass shell-safe subcommands: KEY_ codes come from the whitelisted
 * maps above; free text is wrapped with `shellQuote` before it reaches here.
 */
async function injectViaInputd(subcommands: string[]): Promise<void> {
  if (subcommands.length === 0) return;
  const { serial } = await emulatorSerial();
  const presses = subcommands
    .map((s) => `inputd-cli ${s} >/dev/null 2>&1 || true`)
    .join(`; sleep ${SETTLE_BETWEEN_PRESSES_S}; `);
  // Only get_screen_size writes to the captured stdout; the presses are silenced.
  const script = `inputd-cli get_screen_size; ${presses}`;
  const out = await adbShell(serial, script, { timeoutMs: 20_000 });
  if (!/\d+\s*x\s*\d+/.test(out)) {
    throw new Error(
      `Vega input channel is not usable: 'inputd-cli get_screen_size' returned no ` +
        `"<W> x <H>" over adb shell. Device output: ${out.trim().slice(0, 200)}`
    );
  }
}

/** Inject a path of D-pad/remote buttons via the on-device `inputd-cli`. */
export async function injectVegaButtons(buttons: RemoteButton[]): Promise<void> {
  await injectViaInputd(remoteButtonsToKeycodes(buttons).map((code) => `button_press ${code}`));
}

/** Press a single named key (keyboard tool `key` vocabulary). */
export async function injectVegaNamedKey(name: string): Promise<void> {
  const code = NAMED_KEYCODES[name.toLowerCase()];
  if (!code) {
    throw new Error(
      `Unknown Vega key "${name}". Supported: ${Object.keys(NAMED_KEYCODES).join(", ")}`
    );
  }
  await injectViaInputd([`button_press ${code}`]);
}

/** Type text into the focused field via `inputd-cli send_text`. */
export async function injectVegaText(text: string): Promise<void> {
  // send_text reads the rest of the line, so an embedded newline would truncate
  // it; reject newlines rather than silently dropping the tail.
  if (/[\n\r]/.test(text)) {
    throw new Error("Vega keyboard text must not contain newlines");
  }
  await injectViaInputd([`send_text ${shellQuote(text)}`]);
}

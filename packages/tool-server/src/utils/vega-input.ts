/**
 * Vega input injection over host `adb`, no bundled binary.
 *
 * The stock on-device `inputd-cli` is run over `adb shell` against the single
 * connected VVD (serial `emulator-<consolePort>`, as in the screenshot path).
 * Its `button_press` / `send_text` drive the `inputmgr-key-injection` device,
 * producing real remote events the Cartesian focus engine acts on — unlike QMP
 * `send-key`, which reaches the QEMU virtual *keyboard* and is ignored there.
 *
 * A lower-level channel than the automation toolkit, and the one proven on the
 * CI VVD (where the toolkit may never attach).
 */
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell, shellQuote } from "./adb";
import { InvalidToolInputError } from "./capability";
import { emulatorSerial } from "./vega-automation";

// TV-remote button → Linux input KEY_ name accepted by `inputd-cli button_press`.
// Verified on-device: select must be KEY_ENTER (KEY_SELECT is a no-op) and home
// KEY_HOMEPAGE (KEY_HOME is inert).
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

// The `tv-remote` tool's schema enum; order follows the map above (D-pad first)
// so tool help reads naturally.
export const REMOTE_BUTTONS = Object.keys(REMOTE_KEYCODES) as RemoteButton[];

// Named keys (the keyboard tool's `key` vocabulary) → KEY_ names.
export const NAMED_KEYCODES: Record<string, string> = {
  "enter": "KEY_ENTER",
  "return": "KEY_ENTER",
  // Back is the TV analog of Escape; KEY_ESC is inert for the focus engine.
  "escape": "KEY_BACK",
  "esc": "KEY_BACK",
  "backspace": "KEY_BACKSPACE",
  "delete": "KEY_DELETE",
  "tab": "KEY_TAB",
  "space": "KEY_SPACE",
  "arrow-up": "KEY_UP",
  "arrow-down": "KEY_DOWN",
  "arrow-left": "KEY_LEFT",
  "arrow-right": "KEY_RIGHT",
  // Vega names function keys KEY_FN_F<n>, not KEY_F<n> (SDK 0.22.6759 key table).
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `KEY_FN_F${i + 1}`])),
};

// Settle between presses so the focus engine keeps up (CI's llvmpipe render is
// slow).
const SETTLE_BETWEEN_PRESSES_S = 0.3;

/** Map a path of buttons to the `inputd-cli` KEY_ codes. */
export function remoteButtonsToKeycodes(buttons: RemoteButton[]): string[] {
  return buttons.map((b) => REMOTE_KEYCODES[b]);
}

// The dev-shell service exposing `inputd-cli` over `adb shell` runs only while
// the VVD's developer mode is ON; with it off every `inputd-cli` command fails,
// `get_screen_size` included — so that probe doubles as the developer-mode and
// liveness gate.
//
// Not `vega device info`'s `inDeveloperMode`: it needs the `vega`/`kepler` CLI
// this adb-only path avoids, and it lags the live state by seconds after a
// toggle.
const SCREEN_SIZE_RE = /\d+\s*x\s*\d+/;
// Distinguishes "developer mode is off" from a generic dead channel, so the
// error can point at the actual fix.
const DEV_SHELL_DOWN_RE = /dev\.shell\.service|developer.?mode/i;

function inputUnavailableError(out: string): FailureError {
  const detail = out.trim().slice(0, 200);
  const message = DEV_SHELL_DOWN_RE.test(out)
    ? `Vega input is unavailable: the on-device developer shell isn't running, so ` +
      `'inputd-cli' can't be reached over adb — this means the VVD's developer mode is off. ` +
      `Enable it (\`vsm developer-mode enable\`, e.g. via \`vega device shell\`) and retry. ` +
      `Device output: ${detail}`
    : `Vega input channel is not usable: 'inputd-cli get_screen_size' returned no ` +
      `"<W> x <H>" over adb shell. Device output: ${detail}`;
  return new FailureError(message, {
    error_code: FAILURE_CODES.VEGA_INPUT_UNAVAILABLE,
    failure_stage: "vega_input_inject",
    failure_area: "tool_server",
    error_kind: "unsupported",
  });
}

/**
 * Run `inputd-cli` subcommands on the VVD in a single `adb shell` round-trip,
 * gated on the channel being live (see the note above).
 *
 * The device-side `case` gate skips the presses unless `get_screen_size` printed
 * "<W> x <H>", so a dead channel fails fast instead of sleeping through
 * thousands of no-op presses. Presses are best-effort with output discarded, so
 * only `get_screen_size` reaches the captured stdout the caller re-checks.
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
  const script =
    `sz=$(inputd-cli get_screen_size 2>&1); printf '%s\\n' "$sz"; ` +
    `case "$sz" in *[0-9]*x*[0-9]*) ${presses} ;; esac`;
  // `tv-remote` admits up to 64 buttons × repeat 50 (~3200 presses), so a fixed
  // timeout would SIGKILL the adb child mid-sequence and leave a schema-valid
  // call partially injected. Budget the cumulative sleeps plus per-press exec
  // overhead, over a base for the probe and adb round-trip.
  const PER_PRESS_BUDGET_MS = SETTLE_BETWEEN_PRESSES_S * 1_000 + 200;
  const timeoutMs = 15_000 + subcommands.length * PER_PRESS_BUDGET_MS;
  const out = await adbShell(serial, script, { timeoutMs });
  if (!SCREEN_SIZE_RE.test(out)) throw inputUnavailableError(out);
}

/** Inject a path of D-pad/remote buttons via the on-device `inputd-cli`. */
export async function injectVegaButtons(buttons: RemoteButton[]): Promise<void> {
  await injectViaInputd(remoteButtonsToKeycodes(buttons).map((code) => `button_press ${code}`));
}

/** Press a single named key (keyboard tool `key` vocabulary). */
export async function injectVegaNamedKey(name: string): Promise<void> {
  const lower = name.toLowerCase();
  // Own-property check: `name` is free text, so "constructor" would otherwise
  // pass the falsy guard with `Object.prototype.constructor`.
  const code = Object.hasOwn(NAMED_KEYCODES, lower) ? NAMED_KEYCODES[lower] : undefined;
  if (!code) {
    // Caller input error (HTTP 400); KEYBOARD_KEY_UNSUPPORTED matches the other
    // keyboard backends (#420).
    throw new InvalidToolInputError(
      `Unknown Vega key "${name}". Supported: ${Object.keys(NAMED_KEYCODES).join(", ")}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "vega_named_key",
        error_kind: "unsupported",
      }
    );
  }
  await injectViaInputd([`button_press ${code}`]);
}

/** Type text into the focused field via `inputd-cli send_text`. */
export async function injectVegaText(text: string): Promise<void> {
  // send_text reads the rest of the line, so an embedded newline would silently
  // truncate the text. Caller input error (HTTP 400), as on Android.
  if (/[\n\r]/.test(text)) {
    throw new InvalidToolInputError("Vega keyboard text must not contain newlines", {
      error_code: FAILURE_CODES.VEGA_TEXT_INVALID,
      failure_stage: "vega_text_newline",
      error_kind: "validation",
    });
  }
  await injectViaInputd([`send_text ${shellQuote(text)}`]);
}

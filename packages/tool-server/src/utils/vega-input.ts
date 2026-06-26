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
import { FAILURE_CODES, FailureError } from "@argent/registry";
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
  "return": "KEY_ENTER", // alias of enter (matches iOS/Android/Chromium)
  // Back is the TV analog of Escape; KEY_ESC is inert for the focus engine.
  "escape": "KEY_BACK",
  "esc": "KEY_BACK", // alias of escape
  "backspace": "KEY_BACKSPACE",
  "delete": "KEY_DELETE",
  "tab": "KEY_TAB",
  "space": "KEY_SPACE",
  "arrow-up": "KEY_UP",
  "arrow-down": "KEY_DOWN",
  "arrow-left": "KEY_LEFT",
  "arrow-right": "KEY_RIGHT",
  // Vega names function keys KEY_FN_F<n> (not KEY_F<n>); KEY_FN_F1..F12 all exist
  // in the device key-name table (verified against system.ext4, SDK 0.22.6759).
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `KEY_FN_F${i + 1}`])),
};

// Settle between presses so the focus engine keeps up (CI's llvmpipe render is
// slow); matches the cadence of the known-good Vega navigation script.
const SETTLE_BETWEEN_PRESSES_S = 0.3;

/** Map a path of buttons to the `inputd-cli` KEY_ codes (pure; unit-tested). */
export function remoteButtonsToKeycodes(buttons: RemoteButton[]): string[] {
  return buttons.map((b) => REMOTE_KEYCODES[b]);
}

// The on-device dev-shell service (`com.amazon.dev.shell.service`) that exposes
// `inputd-cli` over `adb shell` runs only while the VVD's developer mode is ON.
// With it off, EVERY `inputd-cli` command — including `get_screen_size` — returns
// "Error: No running instances of com.amazon.dev.shell.service found" (verified
// on a real VVD by toggling `vsm developer-mode`). So the `get_screen_size` probe
// IS the developer-mode + liveness gate: run it first, run the presses only when
// it prints "<W> x <H>", and otherwise fail loudly with an actionable error.
//
// We deliberately do NOT consult `vega device info`'s `inDeveloperMode`: it needs
// the `vega`/`kepler` CLI this adb-only path avoids, and it lags the live state by
// seconds after a toggle (observed: `inputd-cli` already works while the field
// still reads false), so it would be both a heavier and a less accurate gate.
const SCREEN_SIZE_RE = /\d+\s*x\s*\d+/;
// Distinguish "developer mode is off" (the dev-shell service is down) from a
// generic dead channel, so the error can point the user at the actual fix.
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
 * Run one or more `inputd-cli` subcommands on the VVD in a single `adb shell`
 * round-trip, gated on the input channel being live — which, over adb, means the
 * VVD's developer mode is ON (see the note above).
 *
 * The script runs `get_screen_size` first and runs the presses ONLY if it printed
 * a "<W> x <H>" shape (a POSIX `case` gate, validated on `/bin/sh`). So a
 * dev-mode-off / dead channel fails fast: without the gate, a long path would
 * `sleep` between thousands of no-op presses for minutes before the caller could
 * tell anything was wrong. The presses are best-effort (`|| true`, output
 * discarded) and settle between, mirroring the proven navigation script; only
 * `get_screen_size` writes to the captured stdout, which the caller re-checks as
 * the authoritative gate.
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
  // Capture get_screen_size, echo it for the caller's gate, and run the presses
  // only when it looks like "<W> x <H>" — a dev-mode-off device then fails fast
  // instead of sleeping through every no-op press.
  const script =
    `sz=$(inputd-cli get_screen_size 2>&1); printf '%s\\n' "$sz"; ` +
    `case "$sz" in *[0-9]*x*[0-9]*) ${presses} ;; esac`;
  // The script's on-device duration scales with the path: every press settles
  // `SETTLE_BETWEEN_PRESSES_S` apart, and `tv-remote` admits up to 64 buttons ×
  // repeat 50 (~3200 presses). A fixed timeout would SIGKILL the adb child
  // mid-sequence on long paths, failing a schema-valid call with a partial
  // inject. Budget the cumulative sleep + per-press exec overhead, plus a base
  // for the probe and adb round-trip.
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
  const code = NAMED_KEYCODES[name.toLowerCase()];
  if (!code) {
    throw new FailureError(
      `Unknown Vega key "${name}". Supported: ${Object.keys(NAMED_KEYCODES).join(", ")}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "vega_named_key",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  await injectViaInputd([`button_press ${code}`]);
}

/** Type text into the focused field via `inputd-cli send_text`. */
export async function injectVegaText(text: string): Promise<void> {
  // send_text reads the rest of the line, so an embedded newline would truncate
  // it; reject newlines rather than silently dropping the tail.
  if (/[\n\r]/.test(text)) {
    throw new FailureError("Vega keyboard text must not contain newlines", {
      error_code: FAILURE_CODES.VEGA_TEXT_INVALID,
      failure_stage: "vega_text_newline",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  await injectViaInputd([`send_text ${shellQuote(text)}`]);
}

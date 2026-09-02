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
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import { adbDeliveredCommand, adbShell, shellQuote } from "./adb";
import { InvalidToolInputError } from "./capability";
import { emulatorSerial } from "./vega-automation";
import { CLEAR_KEY_PAIRS } from "../tools/keyboard/key-codes";

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

// The `clear` burst's own budget, and NOT the per-press one above: that one
// paces D-pad navigation, where a 0.3s settle per press lets the focus engine
// keep up. A delete key has no focus move to wait for, so the burst runs the
// presses back to back inside ONE `inputd-cli series` — measured at 9.4s for the
// 200 presses against a focused React Native `TextInput` on an OS 1.1 VVD, where
// the same presses at the default hold take 57s. 90s keeps a hung adb child
// bounded while leaving that margin, matching `ADB_CLEAR_TIMEOUT_MS` on Android.
export const VEGA_CLEAR_TIMEOUT_MS = 90_000;

// `button_press <key> holdDuration <ms>` — the down/up gap. The default press
// (`short`) holds ~250ms, which is what makes an unqualified burst take a
// minute; 20ms was measured delivering every key of a 200-press burst (250
// characters -> 50, exactly 200 deletions) while a 1ms hold, though faster
// still, leaves no margin for a loaded guest.
const CLEAR_HOLD_MS = 20;

// `inputd-cli` prints one of these per press it actually performs, and it is the
// only proof the burst did anything: the CLI exits 0 whatever it made of its
// arguments (measured: an unknown option prints nothing and still exits 0), and
// the `|| true` the shared injector wraps presses in would swallow even that.
// Counting them on-device turns "adb accepted the command" into "the device
// injected 200 presses" — without that, a Fire TV image whose `series` or
// `holdDuration` differs answers `{ keys: 200, cleared: true }` for a field it
// never touched, which is the silent failure this burst must not have.
const INJECTED_LINE = "Injecting Button Press";
const INJECTED_MARKER = "ARGENT_VEGA_INJECTED";
const INJECTED_RE = /ARGENT_VEGA_INJECTED=(\d+)/;

/**
 * Empty the focused text field: `CLEAR_KEY_PAIRS * 2` `KEY_BACKSPACE` presses,
 * as ONE `inputd-cli series` invocation, and verify on-device that every press
 * was performed.
 *
 * Backspaces only, where iOS, Android and Apple TV interleave a forward-delete —
 * because Vega has no forward delete to send. `KEY_DELETE` there deletes
 * BACKWARD: measured on an OS 1.1 VVD against a field holding 250 `a`s with the
 * caret proven to be at the end (an `inputd-cli send_text "zz"` appended there),
 * five `KEY_DELETE` presses removed the "zz" and three of the `a`s before it —
 * a true forward delete is a no-op at the end of a field. So the burst is
 * one-directional: it removes up to `CLEAR_KEY_PAIRS * 2` characters BEFORE the
 * caret and leaves anything after it, and `keys` still reports the 200 presses
 * issued.
 *
 * Its own script rather than `injectViaInputd`: that one discards each press's
 * output behind `>/dev/null 2>&1 || true`, which is right for a `tv-remote` path
 * where one bad press must not abort the rest, and wrong for an operation whose
 * whole effect IS that one command.
 */
export async function injectVegaClear(signal?: AbortSignal): Promise<void> {
  // `series` takes its actions as separate argv words and splits them on
  // commas, so the whole burst is a single on-device process rather than 200 of
  // them. The KEY_ name comes from the whitelisted map above and the hold is a
  // literal, so nothing here is caller-controlled.
  const press = `button_press ${NAMED_KEYCODES.backspace} holdDuration ${CLEAR_HOLD_MS}`;
  const presses = Array.from({ length: CLEAR_KEY_PAIRS * 2 }, () => press).join(" , ");
  // Same `get_screen_size` gate the shared injector uses — it doubles as the
  // developer-mode and liveness probe, and the `case` keeps the presses from
  // running at all on a dead channel.
  const script =
    `sz=$(inputd-cli get_screen_size 2>&1); printf '%s\\n' "$sz"; ` +
    `case "$sz" in *[0-9]*x*[0-9]*) ` +
    `out=$(inputd-cli series ${presses} 2>&1); ` +
    `printf '${INJECTED_MARKER}=%s\\n' "$(printf '%s\\n' "$out" | grep -c '${INJECTED_LINE}')"; ` +
    // The count cannot say WHY a press was refused, and that refusal is the one
    // thing the `injected === 0` repair asks the operator to report. `$out` was
    // consumed only by `grep -c` and never printed, so "Device output:" carried
    // the screen size and the count the sentence already states. Everything that
    // is not an "Injecting Button Press" line IS the diagnosis; capped
    // on-device so a chatty build cannot push a wall of text back.
    `printf '%s\\n' "$out" | grep -v '${INJECTED_LINE}' | head -c 400 ` +
    `;; esac`;

  // Resolved BEFORE the abort is sampled. `emulatorSerial` scans the process
  // table and then polls `adb devices` for up to 8s, so an abort landing inside
  // that window used to leave the flag false while the injection had still not
  // started — and the failure was then reported as "may be PARTIALLY emptied"
  // for a field nothing had touched. A device that is not there fails here with
  // its own code (VEGA_DEVICE_NOT_FOUND) and its own repair, untouched by the
  // re-statement below.
  const { serial } = await emulatorSerial();
  // Node's `execFile` with an already-aborted signal never spawns the child, so
  // this is the one case where the code can PROVE nothing was sent — and the
  // rejection looks identical to a mid-flight abort's (both `ABORT_ERR` with no
  // `killed`/`signal`), so WHEN the flag is read is the only discriminator.
  const cancelledBeforeSend = signal?.aborted === true;

  let out: string;
  try {
    out = await adbShell(serial, script, { timeoutMs: VEGA_CLEAR_TIMEOUT_MS, signal });
  } catch (err) {
    // The adb CLIENT rejects an unreachable device before it delivers anything,
    // and the leading sentence is the authoritative one — an agent that believes
    // "may be PARTIALLY emptied" re-reads a field that never changed, with a
    // `describe` that fails on the same dead device.
    const delivered = !cancelledBeforeSend && adbDeliveredCommand(err);
    throw new FailureError(
      (delivered
        ? `the clear burst did not finish on ${serial}, and the focused field may be PARTIALLY ` +
          `emptied — the ${CLEAR_KEY_PAIRS * 2} delete keys are sent as one ` +
          "`inputd-cli series`, which is not atomic. Read the field back (`describe`) before " +
          "clearing or typing again. "
        : cancelledBeforeSend
          ? `the clear burst was cancelled before it was sent to ${serial}, so NO delete key was ` +
            "sent and the focused field is unchanged. The request had already been aborted — the " +
            "caller disconnected, or the run was cancelled — when the burst was due, so no adb " +
            "child was ever started. Nothing needs to be read back. "
          : `the clear burst never reached ${serial}: adb rejected the command before delivering ` +
            "it, so NO delete key was sent and the focused field is unchanged. This is a device " +
            "connection problem, not a field problem — check `list-devices` and retry the clear " +
            "once the VVD is back. ") +
        "Underlying failure: " +
        firstLineOf(err),
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
        failure_stage: "keyboard_clear_vega_burst",
        failure_area: "tool_server",
        error_kind: getFailureSignal(err)?.error_kind ?? "subprocess",
        failure_command: "adb",
        ...subprocessMetadataOf(err),
      }
      // No `cause`, for the reason `injectAndroidClear` gives: the adb error
      // quotes the whole command line, which here is the 200-press series.
    );
  }

  // The gate answered first, so a dead input channel is that failure and not a
  // half-emptied field — its message names the fix (developer mode).
  if (!SCREEN_SIZE_RE.test(out)) throw inputUnavailableError(out);

  const injected = Number(INJECTED_RE.exec(out)?.[1] ?? Number.NaN);
  if (injected !== CLEAR_KEY_PAIRS * 2) {
    throw new FailureError(
      (injected === 0
        ? `the clear burst reached ${serial} but injected nothing: \`inputd-cli series\` ` +
          "performed 0 of the " +
          `${CLEAR_KEY_PAIRS * 2} presses, so the focused field is unchanged. The command is ` +
          "built from a fixed key name and hold, so this means this device's `inputd-cli` does " +
          "not accept them — empty the field with the app's own on-screen keyboard, driven with " +
          "`tv-remote`, and report the device build. "
        : `the clear burst was only partly performed on ${serial}: \`inputd-cli series\` ` +
          `reported ${Number.isNaN(injected) ? "no" : injected} of the ${CLEAR_KEY_PAIRS * 2} ` +
          "presses, so the focused field may be PARTIALLY emptied. Read it back (`describe`) " +
          "before clearing or typing again. ") +
        "Device output: " +
        (deviceDiagnosis(out) || "`inputd-cli series` printed nothing but its own press lines"),
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
        failure_stage: "keyboard_clear_vega_injected",
        failure_area: "tool_server",
        // Only the WHOLESALE refusal is a capability verdict ("stop trying on
        // this device"). A partial injection is the transient its own repair
        // describes — read the field back and retry — and one bucket made the
        // two indistinguishable in telemetry. A missing marker line falls to
        // "subprocess" with the partial arm, whose wording it shares.
        error_kind: injected === 0 ? "unsupported" : "subprocess",
        failure_command: "adb",
      }
    );
  }
}

/**
 * `inputd-cli series`'s own words, without the two lines already in the sentence
 * above it — line 0 is the `get_screen_size` echo, and the marker line is the
 * count.
 */
function deviceDiagnosis(out: string): string {
  return out
    .split("\n")
    .slice(1)
    .filter((line) => !line.includes(INJECTED_MARKER))
    .join(" ")
    .trim()
    .slice(0, 200);
}

/**
 * The subprocess half of an already-wrapped adb failure's signal, ready to
 * spread over the re-statement above.
 *
 * Read off the `FailureError`'s own signal rather than the raw `execFile` error:
 * by this point `runAdb` has already wrapped it, and a `FailureError` keeps its
 * code and signal behind a non-enumerable symbol — so a spread of `err` recovers
 * nothing, and the SIGKILL from the 90s cap (the failure this budget exists to
 * bound) would stay unrecoverable. Same shape as `subprocessMetadataOf` in
 * ./android-input.ts.
 */
function subprocessMetadataOf(
  err: unknown
): Pick<FailureSignal, "failure_exit_code" | "failure_signal" | "failure_spawn_code"> {
  const signal = getFailureSignal(err);
  if (!signal) return {};
  const { failure_exit_code, failure_signal, failure_spawn_code } = signal;
  return {
    ...(failure_exit_code === undefined ? {} : { failure_exit_code }),
    ...(failure_signal === undefined ? {} : { failure_signal }),
    ...(failure_spawn_code === undefined ? {} : { failure_spawn_code }),
  };
}

// The press list, and ONLY the press list. Bounded to the `button_press` runs
// themselves rather than to the end of the line: `formatSubprocessFailure` emits
// `adb <argv> failed: <stderr>` on ONE line, and the argv holds the burst — so a
// redaction that ran to the newline swallowed ` failed: <stderr>` with it and
// left every Vega clear failure quoting a command and no diagnosis. `{2,}`, so a
// stray single press elsewhere in a message stays readable.
const PRESS_RUN = /(?:button_press KEY_[A-Z0-9_]+(?: holdDuration \d+)?\s*,?\s*){2,}/g;

/**
 * The failure's own first line, without the 200-press series it quotes.
 *
 * `formatSubprocessFailure` and Node's nested "Command failed:" each repeat the
 * command into agent context, and this one is ~8KB of `button_press`.
 *
 * Same shape as `firstLine` in ./android-input.ts, banner strip and
 * `failed:`-continuation included: a COLD adb prints two `* daemon …` lines
 * ahead of its error, and with them gone the head can end at its own `failed:`
 * with the real error on the next line.
 */
function firstLineOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message
    .replace(/\* daemon[^\n]*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const head = lines[0] ?? "";
  // With the banner gone, the head can end at its own `failed:` and have
  // NOTHING after it — the banner was adb's only output. That is the 90s
  // budget's SIGKILL against a cold adb, i.e. the first Android call of a
  // tool-server's life, and it left the caller a dangling "failed:" naming no
  // failure at all.
  const detail =
    lines[1] ?? "adb printed only its daemon banner before it stopped, and no error of its own";
  const line = /failed:$/.test(head) ? `${head} ${detail}` : head;
  return line.replace(PRESS_RUN, "<the delete burst> ");
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

import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../utils/capability";
import {
  SECRET_PLACEHOLDER_MARKER,
  redactSecretsFromError,
  resolveSecretPlaceholders,
} from "../../utils/secrets";
import type { KeyboardParams, KeyboardResult } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeIosDeviceImpl } from "./platforms/ios-device";
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

// `text` and `key` are at-most-one, and the advertised JSON Schema cannot say
// so: `not` is one of the top-level combinators #782 banned repo-wide, and
// `tool-input-schema-contract.test.ts` fails any tool declaring one — the
// Messages API rejects such a request with a 400 that fails EVERY tool in it.
// The check therefore runs in `execute`, and the constraint reaches a client
// only as prose: both fields' `.describe()` and the tool description each
// restate it, so a caller reading either parameter alone still sees it.
const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id)."
    ),
  text: z
    .string()
    .optional()
    .describe(
      "Text to type character by character. Cannot be combined with `key` in one call — one call per action; " +
        "to type and then press a key, put two `keyboard` steps in one `run-sequence`. " +
        "Handles uppercase and common punctuation. " +
        "To type a credential without its plaintext ever entering your context, use a secret placeholder: " +
        '`{{secret:<NAME>}}` — e.g. text: "{{secret:APP_PASSWORD}}". The value is resolved on the machine running the ' +
        "tool-server, from the first source that defines the name: the `ARGENT_SECRET_<NAME>` environment variable, " +
        "`.argent/secrets.env` in the project, the project's `.env.local` / `.env` (only their `ARGENT_SECRET_`-prefixed keys), " +
        "then `~/.argent/secrets.env`. Nothing else on the host is reachable. " +
        "Placeholders can be embedded in longer text and are never echoed back resolved. " +
        "If the secret you need is not set, the failure lists the available names and every source it looked in — ask the user to add it " +
        "to one of them (a secrets file applies immediately; an env var needs a restart), NEVER ask the user to paste the secret value into the conversation."
    ),
  key: z
    .string()
    .optional()
    .describe(
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1-f12. Cannot be combined with `text` in one call: one call per action; to type and then press a key, put two `keyboard` steps in one `run-sequence`. Not supported on TV targets; move focus with `tv-remote` (up/down/left/right) instead. Physical iOS: only `enter` and `backspace`."
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50). Ignored on Android phones/tablets (typed via `adb input text`, which has no per-key cadence), on Vega (text/keys injected in a single shot), on TV targets (Apple TV / Android TV type the whole string at the daemon's own cadence), and on physical iOS."
    ),
});

type Params = z.infer<typeof zodSchema>;

// True when an Android phone/tablet read-back proved the typed text did not
// land (`verified: false`, see platforms/android-verify.ts), returned rather
// than thrown — the same shape gap `isUnmetUiWaitResult` closes for
// `await-ui-element`. An ABSENT `verified` means "not checked", never "checked
// and failed", so it is deliberately not matched. `unknown` because the result
// crosses the registry boundary untyped.
export function isUnlandedKeyboardTextResult(
  toolId: string,
  result: unknown
): result is { verified: false; note?: string } {
  if (toolId !== "keyboard") return false;
  if (typeof result !== "object" || result === null) return false;
  return (result as { verified?: unknown }).verified === false;
}

// The read-back's advisory `note`; `unknown` for the same reason as above.
export function keyboardResultNote(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const note = (result as { note?: unknown }).note;
  return typeof note === "string" && note !== "" ? note : undefined;
}

/**
 * Prefixed onto a read-back note when the call typed a resolved `{{secret:…}}`.
 *
 * Most of the notes `platforms/android-verify.ts` returns close by telling the
 * agent to read the field back with `describe`. For a credential that is a
 * plaintext leak: `describe`'s Android parser redacts a node only where the app
 * sets `password="true"`, so a secret in an ordinary field comes back as that
 * element's label. This layer is the only one that knows a placeholder was
 * resolved, and the warning goes first so it is read before the advice it
 * overrides.
 */
const SECRET_READ_BACK_WARNING =
  "This call typed a resolved `{{secret:...}}` value, so do NOT `describe` or `screenshot` this " +
  "field to inspect it: unless the app marks the field as a password field, both hand the " +
  "plaintext back. Submit or navigate away first, then verify the resulting screen. Disregard " +
  "the rest of this note where it says to read this field back. ";

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// TV is a `runtimeKind`, not a `platform` — a tvOS sim dispatches as "ios" and
// an Android TV as "android" by id shape — so those two branches probe the kind
// at runtime and route a TV target to the focus-driven backend. A non-TV target
// types over the simulator-server on iOS but over `adb shell input` on Android:
// the HID transport is silently dropped on `hw.keyboard = no` AVDs (#449).
// Nothing is declared in `services`, because the registry resolves declared
// services before `execute` — the TV probe is async, and simulator-server would
// then be spawned even for a tvOS udid it cannot drive.
export function createKeyboardTool(registry: Registry): ToolDefinition<Params, KeyboardResult> {
  const dispatch = dispatchByPlatform<
    Record<string, unknown>,
    Record<string, unknown>,
    KeyboardParams,
    KeyboardResult,
    Record<string, unknown>,
    Record<string, unknown>
  >({
    toolId: "keyboard",
    capability,
    ios: makeIosImpl(registry),
    iosDevice: makeIosDeviceImpl(registry),
    iosRemote: makeIosRemoteImpl(registry),
    android: makeAndroidImpl(registry),
    chromium: makeChromiumImpl(registry),
    vega: vegaImpl,
  });
  return {
    id: "keyboard",
    interaction: {
      // Never quote the parameters: `text` may hold a plaintext credential and
      // `key` is an unvalidated free string here, yet these messages reach the
      // event log before `execute` runs.
      //
      // That ordering also makes `startedMsg` word requests `execute` then
      // rejects (text+key, `{ key: "" }`), while `completedMsg` runs only after
      // a success and sees neither. Both see the empty request, a no-op.
      startedMsg: ({ params }) => {
        if (params.text === undefined) return "Pressing a key";
        if (params.key === undefined) return "Entering text";
        return "Entering text and pressing a key";
      },
      // Not `!result.verified`: an absent `verified` means not checked, and
      // reporting a plain "Entered text" over a `false` reproduces, on the line
      // a user watches the run by, the silent success the read-back exists to
      // catch.
      completedMsg: ({ params, result }) =>
        params.text === undefined
          ? "Pressed a key"
          : `Entered text${result.verified === false ? " (text did not land)" : ""}`,
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    description: `Type text or press special keys on the device (iOS simulator, Android emulator or device, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number, verified?: boolean, note?: string, reactivated?: true }. On physical iOS, reactivated: true = app was re-fronted; re-describe. On an Android phone or tablet the typed text is read back off the screen, because \`adb input text\` injects it as one key-event burst that a field re-rendering per keystroke silently drops part of. verified=true means the focused field really holds the text. verified=false means the read-back did not confirm it: either the field was read and does not hold the text — note then reports how many characters were typed and how many the field now holds in total (that total includes anything the field already showed, so it is not a loss count) — or the text was already measured not to have landed and the repair either failed outright or could not be confirmed by a further read, which note says instead. Before reporting a failure the tool repairs the field ONCE where it can prove which characters are its own: it backspaces that many and retypes them in smaller chunks, so a \`keyboard\` call may modify the field beyond appending, and a long string spends tens of seconds there (this tool is long-running and has no deadline of its own). It leaves the field untouched where it cannot prove which characters are its own — a hint that overlaps the typed text, or a reading a replaced selection explains just as well. verified is absent whenever the check could not conclude — no editable field held focus, focus moved to another field mid-typing, more than one window reported an editable field with focus (what a dialog over the app looks like, where nothing says which one takes typing), the focused field is a password field (deliberately not read back), the read failed, came back empty or was truncated, the reading is equally consistent with success and failure, or the android-devtools helper is unavailable — with note giving the reason. A reading that concludes nothing can also follow the repair, so an absent verified is no promise the field is untouched; note says what was retyped. After a repair the other reasons report false rather than absent, because the last measurement is then a failure. It is also absent on every other platform, including Android TV, which shares this transport but is not checked: absent always means "not checked", never "checked and fine". note is absent when there is nothing to caveat.
Fails if text and key are both given in one call (rejected before anything is typed), if an unsupported key name is provided, if the device's input backend is not reachable, or if the caller cancels — a cancellation seen before the first keystroke types nothing, the iOS and Chromium backends stop between keys once one arrives mid-call, and an Android call stops once the burst it is in has gone out — mid-typing that is right after the burst, or after the read-back that follows it on the path that verifies, and inside a repair at the next chunk or backspace batch (on a TV target the daemon types the whole string regardless, as Vega does in its single shot). A read-back that cannot run never fails the call: the text is typed either way.
A failure is not rolled back. An unsupported key name is always rejected before anything is sent. Un-typeable text is not: the iOS simulator and Chromium reject it mid-string and leave the characters before it in the field (Android, Vega and TV targets check the whole string up front). A transport failure partway also leaves the text already sent. A cancellation during the Android repair can leave the field holding LESS than before the call, since the repair backspaces before it retypes and stops at its next device call once the caller is gone. Before typing again after any failure, read the field's actual contents — do not assume it is unchanged.
- text: types a string (supports uppercase, digits, common punctuation). To type a credential, use \`{{secret:<NAME>}}\` — resolved server-side from the \`ARGENT_SECRET_<NAME>\` env var or an argent secrets file (\`.argent/secrets.env\` in the project, \`~/.argent/secrets.env\`, or an \`ARGENT_SECRET_\`-prefixed key in the project's \`.env\`/\`.env.local\`), so the plaintext never enters agent context; the result echoes the placeholder, not the value, and the after-typing auto-screenshot is skipped. To submit after typing a secret, put both steps in ONE \`run-sequence\` — that keeps the skip covering the Enter, which a second bare \`keyboard\` call would not.
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1-f12). NOT supported on TV targets; move focus with \`tv-remote\` instead. Physical iOS: only \`enter\` and \`backspace\`.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
One call does one action: pass text OR key, never both. To type and then press a key, send two \`keyboard\` steps in one \`run-sequence\` — { text: "hello" } then { key: "enter" } — which also keeps it to a single round-trip.`,
    zodSchema,
    capability,
    // A long string's chunked repair (one `adb shell input` per 8 characters,
    // each paying its own `app_process` spawn) outruns the MCP adapter's 30 s
    // fetch timeout, which cancels nothing: it replays the IDENTICAL POST up to
    // five times against the same still-running server, and this tool is not
    // idempotent, so each replay types the whole string again on top of what the
    // abandoned call left.
    longRunning: true,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback",
    services: () => ({}),
    execute: async (services, params, options) => {
      // A combined call has no meaning a caller can rely on: `key: "enter"` reads
      // as "type, then submit", `key: "backspace"` just as naturally as "delete,
      // then type" — and whichever order a backend picks, the other reading
      // silently corrupts the field (#579). Rejected ahead of the secret
      // resolution and the dispatch below, so a combined request resolves no
      // `ARGENT_SECRET_*` value and reaches no device.
      if (params.text !== undefined && params.key !== undefined) {
        // `undefined`, not truthiness: the rule is about the shape of the
        // request, so `{ text: "", key: "enter" }` is rejected too.
        throw new InvalidToolInputError(
          // Says what did NOT happen, so the caller retries instead of first
          // inspecting the field. The example is literal because an ellipsis is
          // non-ASCII and the Android backend rejects it.
          //
          // The TV caveat is static, not probed: this guard runs above the
          // dispatch, so the target kind is unknown here — yet without it the
          // prescribed `{ key: "enter" }` is a retry that cannot succeed on a
          // TV, where `key` is rejected outright (platforms/tv.ts).
          "keyboard takes `text` or `key`, not both — nothing was typed. To type and then press " +
            'a key, send two `keyboard` steps in one `run-sequence`: { text: "hello" } followed by ' +
            '{ key: "enter" }. On a TV target (Apple TV / Android TV) `key` is not supported at ' +
            "all — type with `text` and move focus with `tv-remote` (up/down/left/right/select)." +
            // One `run-sequence` and two bare calls are NOT equivalent once the
            // text carries a placeholder, and this message is where an agent
            // converts a combined secret call. Syntactic check, so the guard
            // still resolves nothing.
            (params.text.includes(SECRET_PLACEHOLDER_MARKER)
              ? " This `text` carries a `" +
                SECRET_PLACEHOLDER_MARKER +
                "...}}` placeholder, so keep both steps in that ONE `run-sequence` rather than " +
                "splitting them into two bare calls: the auto-screenshot skip is decided per tool " +
                'call from the whole request, and a separate { key: "enter" } call carries no ' +
                "placeholder — its screenshot is taken after the key lands and can capture the " +
                "still-visible secret."
              : ""),
          {
            error_code: FAILURE_CODES.KEYBOARD_TEXT_AND_KEY_COMBINED,
            failure_stage: "keyboard_text_and_key_combined",
          }
        );
      }
      // An empty `key` is rejected, an empty `text` is not: `key` names one
      // member of a closed set and `""` is not a member, while `text` is a
      // payload whose empty value means the same as omitting it (the no-op).
      //
      // Without this the empty name slips between both layers — this tool
      // decides `key` by presence, every backend dispatches it by truthiness
      // (`if (params.key)`) — so `{ key: "" }` reached a device, pressed
      // nothing, and returned `{ typed: "", keys: 0 }`, which the caller cannot
      // tell apart from a real press.
      if (params.key === "") {
        throw new InvalidToolInputError(
          // Names the omission as the alternative: a caller that sent an empty
          // string usually built the value from something absent.
          "`key` is an empty string, which names no key — nothing was pressed. Pass a named key " +
            "(enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, " +
            "f1–f12), or omit `key` if there is nothing to press.",
          {
            // The same code an unknown name gets: one telemetry bucket for
            // every unusable `key` value.
            error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
            failure_stage: "keyboard_named_key_empty",
            error_kind: "unsupported",
          }
        );
      }
      // Checked here as well as in the backends: the last point where nothing
      // has been sent to the device — and on a TV target the only one, since the
      // per-word loop lives behind the control blueprint's own API.
      options?.signal?.throwIfAborted();
      // Resolve inside `execute`: after every logging boundary (agent
      // transcript, mcp-calls.log, the event log and recorded flow YAMLs all
      // see only the placeholder) and before the dispatch, so run-sequence and
      // flow `type` steps are covered for free.
      if (params.text === undefined) return dispatch(services, params, options);
      const { text, secrets } = resolveSecretPlaceholders(params.text);
      if (secrets.length === 0) return dispatch(services, params, options);
      try {
        const result = await dispatch(services, { ...params, text }, options);
        return {
          ...result,
          // Echo the placeholder form, never the resolved value.
          typed: params.text,
          // The note's own closing advice is unsafe for a secret; correct it
          // rather than emit it. See SECRET_READ_BACK_WARNING.
          ...(result.note === undefined ? {} : { note: SECRET_READ_BACK_WARNING + result.note }),
          // The note is deliberately NOT scrubbed: it is value-free by
          // construction (`keyboard-secrets.test.ts` pins that), and the
          // substitution is destructive on curated prose — see `redactSecrets`.
          // It could not save a leak either: it matches whole values only, and a
          // dropped-character read-back holds a PARTIAL secret. Errors, which
          // quote the `input text` argv verbatim, are still scrubbed below.
        };
      } catch (err) {
        // A backend error can quote its input (e.g. the Android `input text`
        // command line) — scrub the resolved values before it propagates.
        throw redactSecretsFromError(err, secrets);
      }
    },
  };
}

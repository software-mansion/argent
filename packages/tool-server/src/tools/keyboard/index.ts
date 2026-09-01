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
import { serializedPerDevice } from "../../utils/device-serial";
import type { KeyboardParams, KeyboardResult } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

// `text`, `key` and `clear` are at-most-one, and the advertised JSON Schema
// cannot say so: `not` is one of the top-level combinators #782 banned
// repo-wide, and `tool-input-schema-contract.test.ts` fails any tool
// declaring one — the
// Messages API rejects such a request with a 400 that fails EVERY tool in it.
// The check therefore runs in `execute`, and the constraint reaches a client
// only as prose: all three fields' `.describe()` and the tool description each
// restate it, so a caller reading any one parameter alone still sees it.
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
      "Text to type character by character. Cannot be combined with `key` or `clear` in one call — one call per action; " +
        "to type and then press a key, or to replace a value, put two `keyboard` steps in one `run-sequence`. " +
        'That rule counts `text` and `key` by PRESENCE, so `{ text: "", key: "enter" }` is rejected as a combined ' +
        "call even though the text is empty; `clear` counts only when it is `true`, so `{ clear: false }` never " +
        "collides. " +
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
      'Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12. Cannot be combined with `text` or `clear` in one call — one call per action; to type and then press a key, put two `keyboard` steps in one `run-sequence`. That rule counts `key` by PRESENCE, so `{ key: "", clear: true }` is rejected as a combined call — omit `key` when there is nothing to press. Not supported on TV targets — move focus with `tv-remote` (up/down/left/right) instead.'
    ),
  clear: z
    .boolean()
    .optional()
    .describe(
      "Set to true to empty the focused text field. Tap the field first — the clear goes wherever keyboard focus is, and " +
        "give that tap at least 500ms to land before the clear: `run-sequence` waits only 100ms between steps and checks " +
        "no focus, so on iOS and Android a burst that arrives early deletes from the PREVIOUSLY focused element and still " +
        "reports success. " +
        "Cannot be combined with `text` or `key` in one call — one call per action; to replace a value, put " +
        '`{ clear: true }` then `{ text: "new value" }` in one `run-sequence`. ' +
        "iOS and Android send 100 backspaces interleaved with 100 forward-deletes, so the caret can sit anywhere in the " +
        "field and a multi-line one empties too; on those two a field holding more than 100 characters on either side of " +
        "the caret keeps the remainder — call `clear` again. Neither reads the field back, so there the result reports " +
        "what was SENT, not what the field now holds: `keys` is 200, the key presses issued. " +
        "Chromium instead selects the focused editable, deletes the selection (no length limit) and then reads the " +
        "field back: `clearVerified: true` is added when that read found it empty, and it is the one structural way to " +
        "tell the two meanings of `cleared` apart. It is absent in the rare case the field could not be read back at all " +
        "(a page that replaced it, sealed `window`, or stopped exposing a value to read), where `cleared` reports the " +
        "accepted delete alone. `keys` is 0, " +
        "because it dispatches no key events. It " +
        "fails when nothing editable has focus (tap the field first), on a field no select-and-delete can empty (a " +
        'date/time input — press `key: "backspace"` on one of those instead — or a readonly, disabled or non-text one), ' +
        "and when a rich-text editor restores the value it just deleted. " +
        "Not supported on TV targets (Apple TV / Android TV) or Vega. `false` means the same as omitting it."
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50). Paces typing only: `clear` runs its delete burst at its own fixed cadence, so this does not apply to it. Also ignored on Android phones/tablets (typed via `adb input text`, which has no per-key cadence), on Vega (text/keys injected in a single shot), and on TV targets (Apple TV / Android TV type the whole string at the daemon's own cadence)."
    ),
});

type Params = z.infer<typeof zodSchema>;

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
        // `clear` first, so a request that also carries one of the other two —
        // the combined shape `execute` is about to reject, which only this
        // formatter sees — is not announced as plain typing.
        if (params.clear === true) return "Clearing the field";
        if (params.text !== undefined && params.key !== undefined)
          return "Entering text and pressing a key";
        if (params.key !== undefined) return "Pressing a key";
        if (params.text !== undefined) return "Entering text";
        // The no-op: `{}` and `{ clear: false }`, which `clear`'s own
        // `.describe()` says mean the same thing. Both used to fall into the
        // `params.text === undefined` arm and be announced — and logged — as a
        // key press that never happened.
        return "Using the keyboard";
      },
      completedMsg: ({ params }) => {
        if (params.clear === true) return "Cleared the field";
        if (params.key !== undefined) return "Pressed a key";
        if (params.text !== undefined) return "Entered text";
        return "Used the keyboard";
      },
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    description: `Type text, press a special key, or clear the focused text field on the device (iOS simulator, Android emulator or device, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text, replace what a field already holds, or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number, cleared?: true, clearVerified?: true }. \`cleared\` means the clear was SENT on iOS/Android and the delete was ACCEPTED on Chromium; \`clearVerified\` is added only where the field was then read back empty, so branch on that rather than on \`keys\`. Fails if more than one of text, key and clear is given in one call (rejected before anything is sent), if an unsupported key name is provided, if clear finds nothing editable focused on Chromium, or if the device's input backend is not reachable.
A failure is not rolled back. An unsupported key name is always rejected before anything is sent. Un-typeable text is not: the iOS simulator and Chromium reject it mid-string and leave the characters before it in the field (Android, Vega and TV targets check the whole string up front). A transport failure partway also leaves the text already sent. On a retry, read the field's actual contents — do not assume it is unchanged.
- text: types a string (supports uppercase, digits, common punctuation). To type a credential, use \`{{secret:<NAME>}}\` — resolved server-side from the \`ARGENT_SECRET_<NAME>\` env var or an argent secrets file (\`.argent/secrets.env\` in the project, \`~/.argent/secrets.env\`, or an \`ARGENT_SECRET_\`-prefixed key in the project's \`.env\`/\`.env.local\`), so the plaintext never enters agent context; the result echoes the placeholder, not the value, and the after-typing auto-screenshot is skipped. To submit after typing a secret, put both steps in ONE \`run-sequence\` — that keeps the skip covering the Enter, which a second bare \`keyboard\` call would not.
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12) — NOT supported on TV targets; move focus with \`tv-remote\` instead.
- clear: empties the focused text field. Tap the field first — it goes wherever keyboard focus is — and let that tap settle for ~500ms before the clear, because \`run-sequence\` waits only 100ms between steps and no backend checks focus. iOS and Android send 100 backspaces interleaved with 100 forward-deletes, so the caret can be anywhere and multi-line fields empty too; there, a field holding more than 100 characters on either side of the caret keeps the remainder — call clear again. Those two read nothing back: the result says what was sent, not what the field now holds (\`keys\` is 200, the key presses issued) and carries no \`clearVerified\`, so assert the field or its consequence if you need proof. Chromium instead selects the focused editable, deletes the selection (no length limit) and reads the field back, adding \`clearVerified: true\` when that read found it empty (absent only when the field could not be read back at all), with \`keys\` 0; it fails if nothing editable has focus, if the field cannot be cleared this way (a date/time input — press key: "backspace" on one of those — or a readonly, disabled or non-text one), or if a rich-text editor restored the value it just deleted. NOT supported on TV targets or Vega. Prefer it over pressing backspace in a loop, and over typing over a filled field: appending to a value the app remembered is a data bug, not a slow path.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
One call does one action: pass text, key OR clear, never two of them. \`text\` and \`key\` count by presence (so { text: "", key: "enter" } is rejected too) while \`clear\` counts only when true, so { clear: false } never collides. To do two in a row, send two \`keyboard\` steps in one \`run-sequence\` — { text: "hello" } then { key: "enter" } to type and submit, or { clear: true } then { text: "hello" } to replace a value — which also keeps it to a single round-trip.`,
    zodSchema,
    capability,
    // A `keyboard` call can legitimately outrun the MCP adapter's 30s fetch
    // timeout, and that timeout is not a cancellation: `fetchWithReconnect`
    // retries on ANY error including its own AbortError, so a slow call was
    // re-sent up to five times, CONCURRENTLY, at the same device — measured
    // through the real stdio adapter at five overlapping invocations and
    // "This operation was aborted" after 154s, with the field holding what the
    // surplus attempts left rather than what the caller asked for.
    //
    // Both slow shapes belong to this tool: an Android `clear` carries 200
    // `input keyevent` injections under a 90s budget (14.9s measured against a
    // debug Flutter field, 16.3s under guest load), and `text` paced with
    // `delayMs` is unbounded by construction. `run-sequence`, which is where
    // the description sends a caller to combine two steps, has been
    // `longRunning` for the same reason — a bare `keyboard` call was the one
    // exposed path.
    longRunning: true,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback",
    services: () => ({}),
    execute: async (services, params, options) => {
      // A combined call has no meaning a caller can rely on: `key: "enter"` reads
      // as "type, then submit", `key: "backspace"` just as naturally as "delete,
      // then type" — and whichever order a backend picks, the other reading
      // silently corrupts the field (#579). `clear` joins the same rule for the
      // same reason, and that is what keeps the clear burst free of the
      // whole-request pre-validation and focus-loss detection a `{ clear, text }`
      // shape would need. Rejected ahead of the secret resolution and the
      // dispatch below, so a combined request resolves no `ARGENT_SECRET_*`
      // value and reaches no device.
      //
      // `undefined`, not truthiness, for `text` and `key`: the rule is about the
      // shape of the request, so `{ text: "", key: "enter" }` is rejected too.
      // `clear` is the one exception — it is a switch rather than a payload, so
      // `clear: false` means what omitting it means, as its `.describe()` says.
      const combined = [
        params.text !== undefined ? "`text`" : undefined,
        params.key !== undefined ? "`key`" : undefined,
        params.clear === true ? "`clear`" : undefined,
      ].filter((name): name is string => name !== undefined);
      if (combined.length > 1) {
        throw new InvalidToolInputError(
          // Says what did NOT happen, so the caller retries instead of first
          // inspecting the field. The example is literal because an ellipsis is
          // non-ASCII and the Android backend rejects it.
          //
          // The TV caveat is static, not probed: this guard runs above the
          // dispatch, so the target kind is unknown here — yet without it the
          // prescribed `{ key: "enter" }` is a retry that cannot succeed on a
          // TV, where `key` is rejected outright (platforms/tv.ts).
          "keyboard takes one of `text`, `key` or `clear` per call, and this one carries " +
            combined.join(" and ") +
            " — nothing was typed, pressed or cleared. To do two of them in a row, send two " +
            '`keyboard` steps in one `run-sequence`: { text: "hello" } followed by ' +
            '{ key: "enter" } to type and submit, or { clear: true } followed by ' +
            '{ text: "hello" } to replace a value. On a TV target (Apple TV / Android TV) ' +
            "neither `key` nor `clear` is supported at all — type with `text` and move focus " +
            "with `tv-remote` (up/down/left/right/select). On Vega, `key` works but `clear` " +
            "does not, so the `{ clear }` half of that split is rejected outright there: empty " +
            "the field with the app's own on-screen keyboard, driven with `tv-remote`, then " +
            "type." +
            // The split above prescribes a `key`, and this request's `key` names
            // none — so following it literally sends a `{ key: "enter" }` the
            // caller never asked for, whose retry then fails with
            // KEYBOARD_KEY_UNSUPPORTED. The empty-`key` guard below cannot say
            // this: the shape rule is deliberately checked first.
            (params.key === ""
              ? " This `key` is an empty string, which names no key at all — if there is nothing " +
                "to press, drop `key` from the request rather than splitting it into two steps."
              : "") +
            // One `run-sequence` and two bare calls are NOT equivalent once the
            // text carries a placeholder, and this message is where an agent
            // converts a combined secret call. Syntactic check, so the guard
            // still resolves nothing. The reason is worded off the OTHER field
            // the request carries: with `clear` there is no later Enter to
            // screenshot, and the exposure sits on the clear step instead.
            (params.text?.includes(SECRET_PLACEHOLDER_MARKER) === true
              ? " This `text` carries a `" +
                SECRET_PLACEHOLDER_MARKER +
                "...}}` placeholder, so keep both steps in that ONE `run-sequence` rather than " +
                "splitting them into two bare calls: the auto-screenshot skip is decided per tool " +
                "call from the whole request, and " +
                (params.key !== undefined
                  ? 'a separate { key: "enter" } call carries no placeholder — its screenshot is ' +
                    "taken after the key lands and can capture the still-visible secret."
                  : "a separate { clear: true } call carries none either, so its screenshot is " +
                    "taken — and on iOS and Android the burst is bounded at 100 characters per " +
                    "side of the caret, so a field that held a longer secret is captured with " +
                    "the remainder still in it.")
              : ""),
          {
            error_code: FAILURE_CODES.KEYBOARD_TEXT_AND_KEY_COMBINED,
            // One code, three stages. Reusing the CODE is the disclosed decision
            // — one telemetry bucket for every misuse of the exclusivity rule —
            // but the stage names the source location, and a single string here
            // makes clear-misuse unmeasurable next to the older text+key one.
            failure_stage:
              params.clear !== true
                ? "keyboard_text_and_key_combined"
                : params.text !== undefined && params.key !== undefined
                  ? "keyboard_text_key_and_clear_combined"
                  : params.text !== undefined
                    ? "keyboard_text_and_clear_combined"
                    : "keyboard_key_and_clear_combined",
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
      // Resolved inside `execute`: after every logging boundary (agent
      // transcript, mcp-calls.log, the event log and recorded flow YAMLs all see
      // only the placeholder) and before the dispatch, so run-sequence and flow
      // `type` steps are covered for free.
      //
      // ABOVE the queue, with the two request-shape guards. An unknown
      // `{{secret:NAME}}` is a request error like theirs — it reaches no device
      // and its repair is to define the secret — so it must come back at once
      // rather than after another session's 90s burst.
      // `placeholder` is the request's own text, kept beside the resolved one so
      // the echo below never has to reach back for it.
      const requested = params.text;
      const resolved =
        requested === undefined
          ? undefined
          : { ...resolveSecretPlaceholders(requested), placeholder: requested };
      // Serialized per device, on the same queue `paste` uses and for the same
      // reason it gives: both tools write to whatever holds keyboard focus over
      // several unserialized steps, so two concurrent calls at one device
      // interleave and BOTH report success. `clear` widens that window from one
      // keystroke to 700ms on iOS and 2-90s on Android — measured on a booted
      // simulator against a 250-character field, `{ clear: true }` with
      // `{ text: "HELLO" }` 200ms behind it left `…aaaaaaaaaaLO`, with "HEL"
      // eaten by backspaces still in flight.
      return serializedPerDevice(params.udid, async () => {
        if (resolved === undefined || resolved.secrets.length === 0) {
          return dispatch(services, params, options);
        }
        try {
          const result = await dispatch(services, { ...params, text: resolved.text }, options);
          // Echo the placeholder form, never the resolved value.
          return { ...result, typed: resolved.placeholder };
        } catch (err) {
          // A backend error can quote its input (e.g. the Android `input text`
          // command line) — scrub the resolved values before it propagates.
          throw redactSecretsFromError(err, resolved.secrets);
        }
      });
    },
  };
}

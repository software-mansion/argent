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
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

// NOTE on mutual exclusion: `text` and `key` are at-most-one. Two house rules
// decide where that constraint can live, and neither leaves room for the
// generated JSON Schema:
//
//   - zod's `.refine()` returns a ZodEffects the Registry ToolDefinition type
//     does not accept (it requires a ZodObject so the JSON Schema generator can
//     walk `.shape`), so the check runs inside `execute` — as on `boot-device`.
//   - A hand-written `inputSchema` cannot carry it either. `not` is one of the
//     top-level keys #782 banned repo-wide, and
//     `tool-input-schema-contract.test.ts` fails any tool that declares one: the
//     Messages API rejects a request whose schemas carry a top-level combinator,
//     and that 400 fails EVERY tool in the request, not just this one.
//
// So the constraint reaches a client only as prose, and it is restated in BOTH
// fields' `.describe()` as well as in the tool description — a caller reading
// either parameter alone still sees it.
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
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12. Cannot be combined with `text` in one call — one call per action; to type and then press a key, put two `keyboard` steps in one `run-sequence`. Not supported on TV targets — move focus with `tv-remote` (up/down/left/right) instead."
    ),
  clear: z
    .boolean()
    .optional()
    .describe(
      "Empty the focused text field before typing. Use this whenever a field may already hold a value — typing alone does NOT replace it: the old text survives and the new text goes in at the caret, which lands after the old value or splices into the middle of it depending on where focus left the caret. " +
        '`{ clear: true, text: "new@example.com" }` replaces a field\'s contents in one call; `{ clear: true }` alone just empties it. ' +
        "Does not count towards `keys`, which reports only what you asked to be entered; `cleared` reports that the clear was carried out, which is not the same as the field having been observed empty — see the tool description. " +
        'Supported on iOS, Android and Chromium; not supported on Vega or TV targets — empty a field there with the app\'s own clear affordance, or on Vega with repeated `key: "backspace"` presses. ' +
        "What each backend does about a swallowed select-all: Android reads the field back after the chord and deletes whatever survived it, repairing the clear; Chromium reads before and after and fails with an error when it observes the value survive, leaving the field for the caller to deal with; on iOS, which cannot read the field at all, a swallowed chord leaves the delete acting as a plain backspace AT THE CARET, so the field ends up one character shorter rather than unchanged and a combined `text` is appended at the end (where focusing jumped). " +
        "On Android the read-back needs the screen's view hierarchy; where that cannot be captured, or where the focused field is one it cannot read (a password box), the clear stays best-effort like iOS. On levels older than `input keycombination` the clear deletes backwards from end-of-LINE, so a multi-line field keeps what sits below the caret, and a field over 150 characters is refused rather than partly deleted; the same refusal can fire on a level that HAS the subcommand when the read-back leaves more residue than backspaces are allowed to clear. A length that cannot be read at all (a password field, or a screen the device would not capture) falls back to a fixed 158 backspaces — more than every length that path accepts, so a field only keeps its head past 158 characters."
    ),
  delayMs: z
    .number()
    // Bounded because iOS typing is serialized per device: the backend holds a
    // modifier down across awaits, so a second call arriving inside that window
    // would have its keystroke delivered as part of the chord, and the fix is a
    // FIFO chain. An unbounded cadence therefore no longer costs only its own
    // call — it holds that device's keyboard, and everything queued behind it.
    //
    // The bound caps ONE keypress, not the hold: that is ~`2 × delayMs ×
    // text.length`, so `{ text: <120 chars>, delayMs: 5000 }` is schema-valid at
    // ~20 minutes. What actually bounds the hold is the abort signal the iOS
    // backend honours (`simulator-server-keys.ts`) — a client that hangs up
    // releases the chain within about one keypress. 5s per keypress is still far
    // past any real cadence, which is what makes it a sane ceiling.
    //
    // A bare `.max()`, deliberately NOT the bound `await-ui-element` puts on
    // `pollIntervalMs` (`.int().min(50).max(5000)`): a cadence has no floor worth
    // enforcing — 0 means "as fast as the transport goes", which is what this
    // PR's own Chromium tests pass — and a fractional or negative value is
    // harmless to `setTimeout`. Verified: `delayMs: -1000` and `delayMs: 2.5` are
    // both accepted, only `5001` is rejected.
    //
    // The number itself is pinned AT the boundary (`keyboard-clear.test.ts`
    // probes `5001`), because `5000`-accepted and `600000`-rejected left it free:
    // raising this to `.max(10000)` kept the whole keyboard suite green, which is
    // how a ceiling whose reason is written above it gets relaxed unnoticed.
    .max(5000)
    .optional()
    .describe(
      "Delay in ms between key presses (default 50, max 5000). Ignored on Android phones/tablets (typed via `adb input text`, which has no per-key cadence), on Vega (text/keys injected in a single shot), and on TV targets (Apple TV / Android TV type the whole string at the daemon's own cadence). On Chromium it ALSO floors how long a `clear` waits before reading the field back (the wait is the larger of this and 50ms), so a slow cadence adds that wait once per clear."
    ),
});

type Params = z.infer<typeof zodSchema>;

/**
 * The `[started, completed]` phrasings for one keyboard request.
 *
 * Kept as one function so the two tenses cannot drift apart, and so every arm of
 * the request shape is named exactly once. A request with none of the three is
 * still possible (`{ udid }` alone types nothing) and reads as a key press,
 * which is what it did before `clear` existed.
 *
 * The text-AND-key arm is asymmetric on purpose. `execute` rejects that shape,
 * but `startedMsg` renders BEFORE it does, so the started phrasing is the one an
 * event log really shows for a request that is about to 400 — and it has to name
 * both halves, or the log reads as a plain typing call. The completed phrasing
 * of the same arm is unreachable, and stays here only so the two tenses are
 * written in one place rather than diverging when the rule next changes.
 */
function keyboardAction(params: Pick<Params, "text" | "key" | "clear">): [string, string] {
  const text = params.text !== undefined;
  const key = params.key !== undefined;
  const [started, completed] =
    text && key
      ? ["entering text and pressing a key", "entered text and pressed a key"]
      : text
        ? ["entering text", "entered text"]
        : ["pressing a key", "pressed a key"];
  if (!params.clear) return [capitalize(started), capitalize(completed)];
  // A clear-only call carries neither `text` nor `key`, so it has nothing else
  // to report and must not be phrased as the key press it never makes.
  if (!text && !key) return ["Clearing a field", "Cleared a field"];
  return [`Clearing a field and ${started}`, `Cleared a field and ${completed}`];
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// `keyboard` goes through `dispatchByPlatform`. The chromium branch resolves the
// CDP session and the vega branch injects over `adb` (`inputd-cli`); the
// ios/android branches runtime-probe their TV kind (TV is a `runtimeKind`, not a
// `platform`, so a tvOS sim is "ios" and an Android TV "android" by id shape)
// and route a TV target to the focus-driven backend. A non-TV target goes to the
// simulator-server on iOS, but to `adb shell input` on Android (phones/tablets —
// the HID transport is silently dropped on `hw.keyboard = no` AVDs, issue #449;
// see platforms/{ios,android,chromium,vega,tv}.ts). No service is declared
// eagerly: distinguishing a TV target is async, and declaring simulator-server up
// front would also spawn it for a tvOS udid it can't drive.
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
      // Treat both text and key as sensitive. `key` is an unrestricted string at
      // this boundary, so a value must not reach the event log before execution
      // validates whether it is a supported named key.
      //
      // `clear` gets its own arm rather than riding the text/key split: a
      // clear-only call carries neither, so without one it announces a key press
      // that never happens, and a `{ clear, text }` call is logged as plain
      // typing with the destructive half unmentioned.
      //
      // Both formatters word a shape by presence, so `startedMsg` announces a
      // combined text+key request, and a `{ key: "" }` one, as though they will
      // happen — it renders BEFORE `execute` rejects either. `completedMsg` runs
      // only after a call that succeeded, so it sees neither.
      startedMsg: ({ params }) => keyboardAction(params)[0],
      completedMsg: ({ params }) => keyboardAction(params)[1],
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    description: `Type text or press special keys on the device (iOS simulator, Android emulator or device, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number, cleared?: boolean }. Fails if text and key are both given in one call (rejected before anything is typed), if an unsupported key name is provided, if \`clear\` is used on a platform that cannot do it, or if the device's input backend is not reachable.
A rejected request never changes the field. An unsupported key name, un-typeable text, and a \`clear\` on a platform that cannot do it are all decided before anything is sent, on every backend; the Android over-length refusal is decided from a READ of the field, so a support probe and a screen dump go to the device first — neither of which changes it. Either way a 400 leaves the field exactly as it was, neither emptied nor half-typed. What is NOT rolled back is a transport failure partway through: the characters already sent stay in the field. On a retry after one of those, read the field's actual contents — do not assume it is unchanged.
- text: types a string (supports uppercase, digits, common punctuation). For a credential, write a \`{{secret:<NAME>}}\` placeholder — the \`text\` parameter documents where it resolves from. Two consequences here: the result echoes the placeholder rather than the value, and the after-typing auto-screenshot is skipped. To press a key after a secret, put both steps in ONE \`run-sequence\` — that keeps the skip covering the key press, which a second bare call would not.
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12) — NOT supported on TV targets; move focus with \`tv-remote\` instead.
- clear: empties the focused field first, because typing alone does NOT replace — against a field that already holds a value (a remembered login, a restored draft, a re-run step) the old text stays and the new text goes in at the caret, landing after the old value or spliced into the middle of it depending on where focus left the caret (on Android and Chromium, tapping a long value to focus it puts the caret where you tapped; on iOS it jumps to the end, so the text really does append). \`{ clear: true, text: "…" }\` replaces a value; \`{ clear: true }\` alone just empties it. iOS, Android and Chromium; rejected on Vega and TV targets. Focus a text field first. \`cleared: true\` reports that the emptying ran, NOT that the field was seen empty — Android and Chromium read it back (each degrading to best-effort where its read cannot: an unreadable page, an uncapturable screen, a field it cannot read), iOS cannot read at all, so assert the value whenever the result matters. What each backend can leave behind — a swallowed select-all, an older Android level's line-scoped delete — is on the \`clear\` parameter.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
One call does one typing action: pass text OR key, never both. \`clear\` rides along with either, and the order within a call is always clear → text, or clear → key. To type and then press a key, send two \`keyboard\` steps in one \`run-sequence\` — { clear: true, text: "hello" } then { key: "enter" } — which also keeps it to a single round-trip.`,
    zodSchema,
    capability,
    // One request can run a clear AND one injection — `text` or `key`, never
    // both — and the two are budgeted separately: on Android the clear is capped
    // at 26s (ANDROID_CLEAR_BUDGET_MS, which derives as ADB_INPUT_TIMEOUT_MS +
    // DELETE_RUN_RESERVE_MS) and the injection that follows keeps its own 15s
    // cap, so a `{ clear, text }` worst case of ~41s still sums past the MCP
    // adapter's 30s per-request fetch timeout. Sizing the legs against 30s
    // instead would mean threading one deadline through the text/key injectors
    // the Android-TV blueprint shares; declaring the tool for what it is costs
    // nothing and stops the client abandoning a request while adb is still
    // typing on the device.
    longRunning: true,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback " +
      "clear erase empty field reset delete contents replace value select all backspace",
    // No eager service: each branch resolves its backend lazily (TV control,
    // simulator-server, CDP, or Vega adb), since distinguishing a TV target is
    // async and a tvOS udid must never resolve simulator-server.
    services: () => ({}),
    execute: async (services, params, options) => {
      // `text` and `key` are mutually exclusive. A combined call has no meaning a
      // caller can rely on: `key: "enter"` reads as "type, then submit", while
      // `key: "backspace"` reads just as naturally as "delete, then type" — and
      // whichever order a backend picks, the other reading silently corrupts the
      // field (#579). One call, one action; a sequence is expressed by making two
      // calls, batched into one `run-sequence` when the round-trip matters.
      //
      // Rejected here, ahead of the secret resolution and the platform dispatch
      // below, so a combined request never resolves an `ARGENT_SECRET_*` value
      // and never reaches a device — no backend has to defend against the shape.
      if (params.text !== undefined && params.key !== undefined) {
        // `undefined`-based, not truthiness: the rule is about the shape of the
        // request, so `{ text: "", key: "enter" }` is rejected too rather than
        // carving out an empty string nobody would have to document.
        throw new InvalidToolInputError(
          // Says what did NOT happen, so the caller retries instead of first
          // inspecting the field — and spells the retry out with a literal
          // example rather than an ellipsis the Android backend can't type.
          //
          // The TV caveat is carried statically rather than by probing the
          // target: this guard runs above the dispatch precisely so a combined
          // request reaches no device, and distinguishing a TV kind is an async
          // probe. Without it the prescribed `{ key: "enter" }` is a retry that
          // cannot succeed on a TV, where `key` is rejected outright
          // (platforms/tv.ts) — which is the diagnosis this guard would
          // otherwise pre-empt.
          "keyboard takes `text` or `key`, not both — nothing was typed. To type and then press " +
            'a key, send two `keyboard` steps in one `run-sequence`: { text: "hello" } followed by ' +
            '{ key: "enter" }. On a TV target (Apple TV / Android TV) `key` is not supported at ' +
            "all — type with `text` and move focus with `tv-remote` (up/down/left/right/select)." +
            // The one-`run-sequence` form and two bare calls are NOT equivalent
            // once the text carries a placeholder, and this message is where an
            // agent converts a combined secret call — the tool description's
            // caveat is read long before that moment, if at all. The check is
            // syntactic (the same `.includes` flow-utils.ts uses), so the guard
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
      // An empty `key` is rejected; an empty `text` is not. The two parameters
      // hold different kinds of value: `key` names one member of a closed set,
      // and `""` is not a member — exactly the case the tool description already
      // promises to fail on ("if an unsupported key name is provided"). `text`
      // is a payload, so an empty one means the same thing as omitting it and
      // stays the documented no-op.
      //
      // Without this the empty name slips between both layers. This tool decides
      // `key` by presence, every backend dispatches it by truthiness
      // (`if (params.key)`), so `{ key: "" }` reached a device, pressed nothing,
      // and still returned `{ typed: "", keys: 0 }` — a success the caller
      // cannot tell apart from a real press.
      if (params.key === "") {
        throw new InvalidToolInputError(
          // Names the omission as the alternative, because a caller that sent an
          // empty string usually built the value from something absent.
          "`key` is an empty string, which names no key — nothing was pressed. Pass a named key " +
            "(enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, " +
            "f1–f12), or omit `key` if there is nothing to press.",
          {
            // The same code an unknown name gets, because that is what this is:
            // one telemetry bucket for every unusable `key` value.
            error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
            failure_stage: "keyboard_named_key_empty",
            error_kind: "unsupported",
          }
        );
      }
      // Secret placeholders resolve here — inside execute, after every logging
      // boundary (agent transcript, mcp-calls.log, the event log, recorded
      // flow YAMLs all see only the placeholder) and before the platform
      // dispatch, so run-sequence and flow `type` steps are covered for free.
      if (params.text === undefined) return dispatch(services, params, options);
      const { text, secrets } = resolveSecretPlaceholders(params.text);
      if (secrets.length === 0) return dispatch(services, params, options);
      try {
        // `secretText` travels with the resolved value so a backend can keep the
        // credential's LENGTH out of its failure messages too — `redactSecrets-
        // FromError` substitutes the value string and cannot redact a count.
        const result = await dispatch(services, { ...params, text, secretText: true }, options);
        // Echo the placeholder form, never the resolved value.
        return { ...result, typed: params.text };
      } catch (err) {
        // A backend error can quote its input (e.g. the Android `input text`
        // command line) — scrub the resolved values before it propagates.
        throw redactSecretsFromError(err, secrets);
      }
    },
  };
}

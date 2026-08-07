import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { redactSecretsFromError, resolveSecretPlaceholders } from "../../utils/secrets";
import type { KeyboardParams, KeyboardResult } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

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
      "Text to type character by character. Handles uppercase and common punctuation. " +
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
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12. When combined with `text`, the key is pressed AFTER the text is typed (so text + enter types and submits). Not supported on TV targets — move focus with `tv-remote` (up/down/left/right) instead."
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50). Ignored on Android phones/tablets (typed via `adb input text`, which has no per-key cadence), on Vega (text/keys injected in a single shot), and on TV targets (Apple TV / Android TV type the whole string at the daemon's own cadence)."
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
      startedMsg: ({ params }) => {
        if (params.text === undefined) return "Pressing a key";
        if (params.key === undefined) return "Entering text";
        return "Entering text and pressing a key";
      },
      // The read-back's verdict belongs here too. This line is where a user
      // watches the run, and reporting "Entered text" over a `verified: false`
      // reproduces in the log exactly the silent success the read-back exists to
      // catch. An absent `verified` stays quiet: it means not checked, and the
      // `note` carries the reason.
      completedMsg: ({ params, result }) => {
        if (params.text === undefined) return "Pressed a key";
        const landed = result.verified === false ? " (text did not land)" : "";
        if (params.key === undefined) return `Entered text${landed}`;
        return `Entered text and pressed a key${landed}`;
      },
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    description: `Type text or press special keys on the device (iOS simulator, Android emulator or device, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number, verified?: boolean, note?: string }. On an Android phone or tablet the typed text is read back off the screen, because \`adb input text\` injects it as one key-event burst that a field re-rendering per keystroke silently drops part of. verified=true means the focused field really holds the text. verified=false means it does not, and note reports how many characters were typed and how many the field now holds in total (that total includes anything the field already showed, so it is not a loss count); before reporting that, the tool retries ONCE where it can prove which characters are its own — it backspaces that many and retypes them in smaller chunks, so a \`keyboard\` call may modify the field beyond appending — and it leaves the field untouched where it cannot prove it, including when the field was empty and its hint overlaps the typed text. verified is absent whenever the check could not conclude — no editable field held focus, focus moved to another field mid-typing, the focused field is a password field (deliberately not read back), the read failed or was truncated, the reading is equally consistent with success and failure, or the android-devtools helper is unavailable — with note giving the reason. It is also absent on every other platform, including Android TV, which shares this transport but is not checked: absent always means "not checked", never "checked and fine". note is absent when there is nothing to caveat.
Fails if an unsupported key name is provided or the device's input backend is not reachable. A read-back that cannot run never fails the call: the text is typed either way.
- text: types a string (supports uppercase, digits, common punctuation). To type a credential, use \`{{secret:<NAME>}}\` — resolved server-side from the \`ARGENT_SECRET_<NAME>\` env var or an argent secrets file (\`.argent/secrets.env\` in the project, \`~/.argent/secrets.env\`, or an \`ARGENT_SECRET_\`-prefixed key in the project's \`.env\`/\`.env.local\`), so the plaintext never enters agent context; the result echoes the placeholder, not the value, and the after-typing auto-screenshot is skipped.
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12) — NOT supported on TV targets; move focus with \`tv-remote\` instead.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
Provide text, key, or both — when both are given, the text is typed first and the key is pressed after it (text + key:"enter" types and submits).`,
    zodSchema,
    capability,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback",
    // No eager service: each branch resolves its backend lazily (TV control,
    // simulator-server, CDP, or Vega adb), since distinguishing a TV target is
    // async and a tvOS udid must never resolve simulator-server.
    services: () => ({}),
    execute: async (services, params, options) => {
      // Secret placeholders resolve here — inside execute, after every logging
      // boundary (agent transcript, mcp-calls.log, the event log, recorded
      // flow YAMLs all see only the placeholder) and before the platform
      // dispatch, so run-sequence and flow `type` steps are covered for free.
      if (params.text === undefined) return dispatch(services, params, options);
      const { text, secrets } = resolveSecretPlaceholders(params.text);
      if (secrets.length === 0) return dispatch(services, params, options);
      try {
        const result = await dispatch(services, { ...params, text }, options);
        return {
          ...result,
          // Echo the placeholder form, never the resolved value.
          typed: params.text,
          // The note is NOT scrubbed, deliberately. The Android backend reads the
          // field back off the screen, so on this path it has held the plaintext,
          // and every note it writes is value-free by construction — counts and
          // structural facts, never the text — which `keyboard-secrets.test.ts`
          // pins directly. Running the substitution over that prose would buy
          // nothing and cost correctness: it replaces bare occurrences of the
          // value anywhere, so a two-character secret rewrites ordinary words
          // ("uiautomator" → "uiautomat{{secret:W}}") and a numeric one swallows
          // the character count the note exists to report, on notes a perfectly
          // successful call returns. It could not save a leak either — it matches
          // whole values only, and a dropped-character read-back holds a PARTIAL
          // secret, which no substitution catches. Errors are different and are
          // still scrubbed below: they quote the `input text` argv verbatim.
        };
      } catch (err) {
        // A backend error can quote its input (e.g. the Android `input text`
        // command line) — scrub the resolved values before it propagates.
        throw redactSecretsFromError(err, secrets);
      }
    },
  };
}

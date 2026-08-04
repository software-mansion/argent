import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../utils/capability";
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
        "`{{secret:<NAME>}}` types the value of the `ARGENT_SECRET_<NAME>` environment variable set on the machine running the tool-server " +
        '— e.g. text: "{{secret:APP_PASSWORD}}" types the value of `ARGENT_SECRET_APP_PASSWORD`. Only env vars with the `ARGENT_SECRET_` prefix are resolvable. ' +
        "Placeholders can be embedded in longer text and are never echoed back resolved. " +
        "If the secret you need is not set, ask the user to export it as `ARGENT_SECRET_<NAME>` and restart the session — NEVER ask the user to paste the secret value into the conversation."
    ),
  key: z
    .string()
    .optional()
    .describe(
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12. Cannot be combined with `text` in one call — one call per action. Not supported on TV targets — move focus with `tv-remote` (up/down/left/right) instead."
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
      //
      // `startedMsg` still describes a text+key request because it renders
      // BEFORE `execute` rejects the combination; `completedMsg` runs only after
      // a call that succeeded, so it never sees both.
      startedMsg: ({ params }) => {
        if (params.text === undefined) return "Pressing a key";
        if (params.key === undefined) return "Entering text";
        return "Entering text and pressing a key";
      },
      completedMsg: ({ params }) => (params.text === undefined ? "Pressed a key" : "Entered text"),
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    description: `Type text or press special keys on the device (iOS simulator, Android emulator or device, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number }. Fails if both text and key are given in one call (rejected before anything is typed), if an unsupported key name is provided, or if the device's input backend is not reachable.
- text: types a string (supports uppercase, digits, common punctuation). To type a credential, use \`{{secret:<NAME>}}\` — resolved server-side from the \`ARGENT_SECRET_<NAME>\` env var (prefix mandatory; \`{{secret:APP_PASSWORD}}\` ↔ \`ARGENT_SECRET_APP_PASSWORD\`), so the plaintext never enters agent context; the result echoes the placeholder, not the value, and the after-typing auto-screenshot is skipped. To submit after typing a secret, put both steps in ONE \`run-sequence\` — that keeps the skip covering the Enter, which a second bare \`keyboard\` call would not.
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12) — NOT supported on TV targets; move focus with \`tv-remote\` instead.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
Provide text OR key, never both. To type and then submit, use two calls, or two \`keyboard\` steps in one \`run-sequence\`: { text: "hello" } then { key: "enter" }.`,
    zodSchema,
    capability,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback",
    // No eager service: each branch resolves its backend lazily (TV control,
    // simulator-server, CDP, or Vega adb), since distinguishing a TV target is
    // async and a tvOS udid must never resolve simulator-server.
    services: () => ({}),
    execute: async (services, params, options) => {
      // `text` and `key` are mutually exclusive. A combined call has no meaning a
      // caller can rely on: `key: "enter"` reads as "type, then submit", while
      // `key: "backspace"` reads just as naturally as "delete, then type" — and
      // whichever order a backend picks, the other reading silently corrupts the
      // field (#579). One call, one action; the sequence is expressed by making
      // two calls.
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
          "keyboard takes `text` or `key`, not both — nothing was typed. To type and then press " +
            'a key, make two calls (or two `keyboard` steps in one `run-sequence`): { text: "hello" } ' +
            'followed by { key: "enter" }.',
          {
            error_code: FAILURE_CODES.KEYBOARD_TEXT_AND_KEY_COMBINED,
            failure_stage: "keyboard_text_and_key_combined",
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
        const result = await dispatch(services, { ...params, text }, options);
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

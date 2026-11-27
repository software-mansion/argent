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
import { noteTypedSecrets } from "../../utils/typed-secrets";
import type { KeyboardParams, KeyboardResult } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeIosDeviceImpl } from "./platforms/ios-device";
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { makeMacosImpl } from "./platforms/macos";
import { vegaImpl } from "./platforms/vega";
import { harmonyImpl } from "./platforms/harmony";

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
  harmony: { device: true },
  macos: { app: true, catalyst: true },
};

// `text` and `key` are at-most-one, and the advertised JSON Schema cannot say
// so: `not` is one of the top-level combinators #782 banned repo-wide, and
// `tool-input-schema-contract.test.ts` fails any tool declaring one — the
// Messages API rejects such a request with a 400 that fails EVERY tool in it.
// The check therefore runs in `execute`, and the constraint reaches a client
// only as prose: both fields' `.describe()` restate it, so a caller reading
// either parameter alone still sees it.
const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices`."),
  text: z
    .string()
    .optional()
    .describe(
      "Text to type. Cannot be combined with `key` (use two steps in `run-sequence` to type then press enter). " +
        "Supports `{{secret:<NAME>}}` placeholders resolved server-side from `ARGENT_SECRET_<NAME>` / `.argent/secrets.env` " +
        "(auto-screenshot is skipped; combine with submit in one `run-sequence` to keep the skip; never ask the user for plaintext)."
    ),
  key: z
    .string()
    .optional()
    .describe(
      "Named key. Cannot be combined with `text` (use two steps in `run-sequence`). Values: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1-f12. " +
        "Not supported on Apple TV / Android TV (use `tv-remote`). Physical iOS: enter/backspace only.<flag:harmonyos> HarmonyOS: enter, backspace, space, arrow-left/right.</flag:harmonyos><flag:macos-apps> Mac app: also delete (forward delete), home, end, page-up/down, and modifier shortcuts (e.g. command+a).</flag:macos-apps>"
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50; ignored on platforms that type in one shot)."
    ),
});

type Params = z.infer<typeof zodSchema>;

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
    Record<string, unknown>,
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
    harmony: harmonyImpl,
    macos: makeMacosImpl(registry),
  });
  return {
    id: "keyboard",
    description: `Type text or press a named key on the focused field (tap or focus the field first; with no focus input is silently dropped).
Use when entering text or triggering named keys (enter, escape, backspace, arrows).
Returns { typed, keys, verified?, warning?, reactivated? }. Fails if an unsupported key is passed or the input backend is unreachable (partial typing is not rolled back; re-read before retrying). On iOS simulators, typing into an empty field verifies readback (\`verified: false\` warns). React Native: after typing, the next tap outside may only close the keyboard (tap again if so); where the field submits on return, \`key: "enter"\` avoids the extra tap.`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv <flag:harmonyos>harmony harmonyos </flag:harmonyos>search field hid leanback",
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
      completedMsg: ({ params }) => (params.text === undefined ? "Pressed a key" : "Entered text"),
      failedMsg: ({ failureSignal }) => `Failed to use keyboard: ${failureSignal.error_code}`,
    },
    capability,
    // Typing time grows with text length on several backends and can outlast the MCP
    // fetch timeout, whose abort replays the call: the text would be typed twice.
    longRunning: true,
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
      // Resolve inside `execute`: after every logging boundary (agent
      // transcript, mcp-calls.log, the event log and recorded flow YAMLs all
      // see only the placeholder) and before the dispatch, so run-sequence and
      // flow `type` steps are covered for free.
      if (params.text === undefined) return dispatch(services, params, options);
      const { text, secrets } = resolveSecretPlaceholders(params.text, {
        clientSecrets: options?.clientSecrets,
      });
      if (secrets.length === 0) return dispatch(services, params, options);
      // Before the keys go out: a failure partway leaves part of a value typed.
      noteTypedSecrets(params.udid, secrets);
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

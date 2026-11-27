import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { redactSecretsFromError, resolveSecretPlaceholders } from "../../utils/secrets";
import { noteTypedSecrets } from "../../utils/typed-secrets";
import { pasteZodSchema } from "./schema";
import type { PasteDispatchParams, PasteParams, PasteResult, PasteServices } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { makeMacosImpl } from "./platforms/macos";

const capability: ToolCapability = {
  apple: { simulator: true },
  // A remote sim pastes over the MoQ transport (`simctl pbcopy` + ⌘V); the HTTP
  // clipboard route does not exist there.
  appleRemote: { simulator: true },
  // Emulators only: the clipboard is set through the emulator's gRPC endpoint,
  // which a physical phone does not have. `unknown` is admitted because an
  // unresolved serial may still be an emulator.
  android: { emulator: true, unknown: true },
  // A Mac app shares the host pasteboard, so its branch inserts the text
  // and never touches the pasteboard.
  macos: { app: true, catalyst: true },
  // No `chromium`: its only clipboard is the HOST one, so a paste would
  // overwrite what the user copied. No `vega`: VVD exposes no clipboard API.
  //
  // TV targets are not separate platforms (an Apple TV simulator is
  // `ios`/`simulator`, an Android TV emulator `android`/`emulator`), so each
  // handler probes the runtime kind and rejects a TV itself.
};

/**
 * A paste is two unserialized steps — fill the clipboard, then send the
 * keystroke — so two concurrent calls on one device can let the second fill
 * land before the first keystroke, pasting one text twice and the other never
 * while both report success.
 */
const pasteQueues = new Map<string, Promise<unknown>>();

function serializedPerDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const previous = pasteQueues.get(deviceId) ?? Promise.resolve();
  const next = previous.then(task, task);
  pasteQueues.set(deviceId, next);
  void next.then(
    () => {
      if (pasteQueues.get(deviceId) === next) pasteQueues.delete(deviceId);
    },
    () => {
      if (pasteQueues.get(deviceId) === next) pasteQueues.delete(deviceId);
    }
  );
  return next;
}

export function createPasteTool(registry: Registry): ToolDefinition<PasteParams, PasteResult> {
  const dispatch = dispatchByPlatform<
    PasteServices,
    PasteServices,
    PasteDispatchParams,
    PasteResult
  >({
    toolId: "paste",
    capability,
    ios: makeIosImpl(registry),
    iosRemote: makeIosRemoteImpl(registry),
    android: makeAndroidImpl(registry),
    macos: makeMacosImpl(registry),
  });
  return {
    id: "paste",
    description: `Set the device clipboard to \`text\` and paste into the focused field (iOS simulator, Android emulator).<flag:macos-apps> Mac app: types \`text\` directly without touching the pasteboard.</flag:macos-apps>
Use when pasting something a real user would paste (OTP/2FA code, long token/URL, or testing paste handling). Use \`keyboard\` for normal typing. Tap the field first to focus it.
Returns \`{ pasted: true, via? }\`. Fails on TV targets, if clipboard/typing fails<flag:macos-apps>, or if the Mac app focus accepts no text</flag:macos-apps>.`,
    zodSchema: pasteZodSchema,
    searchHint: "paste clipboard pasteboard otp 2fa code fill field",
    interaction: {
      startedMsg: () => "Pasting text",
      completedMsg: () => "Pasted text",
      failedMsg: ({ failureSignal }) => `Failed to paste text: ${failureSignal.error_code}`,
    },
    capability,
    services: () => ({}),
    execute: async (services, params, options) => {
      // Resolve inside `execute`: after every logging boundary (transcript,
      // event log and recorded sequences see only the placeholder) and before
      // the dispatch.
      const { text, secrets } = resolveSecretPlaceholders(params.text, {
        clientSecrets: options?.clientSecrets,
      });
      return serializedPerDevice(params.udid, async () => {
        if (secrets.length === 0) return dispatch(services, params, options);
        noteTypedSecrets(params.udid, secrets);
        try {
          return await dispatch(services, { ...params, text, hasSecrets: true }, options);
        } catch (err) {
          throw redactSecretsFromError(err, secrets);
        }
      });
    },
  };
}

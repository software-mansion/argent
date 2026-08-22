import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { redactSecretsFromError, resolveSecretPlaceholders } from "../../utils/secrets";
import { pasteZodSchema } from "./schema";
import type { PasteParams, PasteResult, PasteServices } from "./types";
import { makeIosImpl, makeIosRemoteImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";

const capability: ToolCapability = {
  apple: { simulator: true },
  // A remote sim pastes over the MoQ transport (`simctl pbcopy` + ⌘V); the HTTP
  // clipboard route does not exist there.
  appleRemote: { simulator: true },
  // Emulators only: the clipboard is set through the emulator's gRPC endpoint,
  // which a physical phone does not have. `unknown` is admitted because an
  // unresolved serial may still be an emulator.
  android: { emulator: true, unknown: true },
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
  const dispatch = dispatchByPlatform<PasteServices, PasteServices, PasteParams, PasteResult>({
    toolId: "paste",
    capability,
    ios: makeIosImpl(registry),
    iosRemote: makeIosRemoteImpl(registry),
    android: makeAndroidImpl(registry),
  });
  return {
    id: "paste",
    interaction: {
      startedMsg: () => "Pasting text",
      completedMsg: () => "Pasted text",
      failedMsg: ({ failureSignal }) => `Failed to paste text: ${failureSignal.error_code}`,
    },
    description: `Paste text into the focused field: puts \`text\` on the DEVICE clipboard (the host clipboard is untouched), then triggers the platform's paste shortcut (iOS simulator, Android emulator).
Do NOT use this in place of \`keyboard\`. \`keyboard\` types as a user would and is the default for all text entry; use \`paste\` only where a real user would paste — a 2FA/OTP code copied from another app, a long link or token, or when testing the app's own paste handling.
Tap the field first so it has focus. Returns { pasted: true }. Fails on a TV target, when the device clipboard cannot be set, or when the simulator-server build lacks clipboard support.
Supports \`{{secret:<NAME>}}\` placeholders like \`keyboard\`; the value is never echoed back.`,
    searchHint: "paste clipboard pasteboard otp 2fa code fill field",
    zodSchema: pasteZodSchema,
    capability,
    services: () => ({}),
    execute: async (services, params, options) => {
      // Resolve inside `execute`: after every logging boundary (transcript,
      // event log and recorded sequences see only the placeholder) and before
      // the dispatch.
      const { text, secrets } = resolveSecretPlaceholders(params.text);
      return serializedPerDevice(params.udid, async () => {
        if (secrets.length === 0) return dispatch(services, params, options);
        try {
          return await dispatch(services, { ...params, text }, options);
        } catch (err) {
          throw redactSecretsFromError(err, secrets);
        }
      });
    },
  };
}

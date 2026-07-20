import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { redactSecretsFromError, resolveSecretPlaceholders } from "../../utils/secrets";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().min(1).describe("iOS simulator UDID — paste is iOS-only."),
  text: z
    .string()
    .describe(
      "Text to paste into the focused field. To paste a credential without its plaintext ever " +
        "entering your context, use `{{secret:<NAME>}}` — resolved server-side from the " +
        "`ARGENT_SECRET_<NAME>` environment variable (prefix mandatory; `{{secret:APP_PASSWORD}}` " +
        "reads `ARGENT_SECRET_APP_PASSWORD`). If the secret is not set, ask the user to export it " +
        "under that prefix — NEVER ask the user to paste the secret value into the conversation."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pasted: boolean;
}

// Capability gate (HTTP layer + dispatchByPlatform-style consumers) rejects
// Android serials with "Tool 'paste' is not supported on android". The handler
// itself is iOS-only — no platforms/ split needed.
const capability: ToolCapability = {
  apple: { simulator: true, device: false },
  appleRemote: { simulator: true },
};

export const pasteTool: ToolDefinition<Params, Result> = {
  id: "paste",
  description: `Fill the focused field on the iOS simulator by pasting text (fastest text entry).
Use when you need to fill a text input with a long string faster than character-by-character typing.
Returns { pasted: true }. Fails if no field is focused or the simulator server is not running.
Tap the text field first to focus it, then call paste.
Supports \`{{secret:<NAME>}}\` placeholders resolved server-side from \`ARGENT_SECRET_<NAME>\` env vars (prefix mandatory), so credentials never enter agent context.
If paste doesn't work for a particular field, use the keyboard tool instead.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    // Secret placeholders resolve here — inside execute, past every logging
    // boundary — so only the placeholder form appears in transcripts and logs.
    const { text, secrets } = resolveSecretPlaceholders(params.text);
    try {
      sendCommand(api, { cmd: "paste", text });
    } catch (err) {
      throw redactSecretsFromError(err, secrets);
    }
    return { pasted: true };
  },
};

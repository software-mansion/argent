import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// A plain object schema: no top-level oneOf/allOf/anyOf (the tool-input-schema
// contract test rejects those). `udid` is top level so the MCP auto-capture
// layer can find the device to screenshot after the run.
export const runScriptZodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS simulator UDID or Android serial). Shared by every ui.* call in the script."
    ),
  script: z
    .string()
    .min(1)
    .describe(
      "JavaScript (NOT TypeScript — no type annotations) async function BODY. It runs in a separate, disposable Node.js process whose only injected globals are `ui` (the device facade) and `console`; each ui.* call crosses an IPC boundary to the tool-server. Only `ui` and `console` are supported (do not use require/import/fs/network), there are no other tools, and the process is discarded after the run. `await` every ui.* call. Discover the `ui` API and copy-pasteable examples from the `argent-device-interact` skill. Use `console.log(...)` to surface values — captured (tail-capped) in the result's `logs`."
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Overall deadline for the whole script, in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On expiry the run aborts any in-flight ui.* call and fails with RUN_SCRIPT_TIMEOUT.`
    ),
});

export type RunScriptParams = z.infer<typeof runScriptZodSchema>;

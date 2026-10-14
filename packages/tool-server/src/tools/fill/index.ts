import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../utils/capability";
import { isAndroidTv } from "../../utils/adb";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isRemoteTvOsSimulator } from "../../utils/sim-remote";
import { redactSecretsFromError, resolveSecretPlaceholders } from "../../utils/secrets";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";
import { fillIos } from "./ios";
import { fillAndroid } from "./android";
import { fillChromium } from "./chromium";
import { fillByDeviceKeys } from "./keys";
import type { FillParams, FillResult } from "./types";

export type { FillResult } from "./types";

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
  text: z
    .string()
    .describe(
      'The text the focused field must hold afterwards; "" clears it. Supports `{{secret:<NAME>}}` placeholders like `keyboard`.'
    ),
});

type Params = z.infer<typeof zodSchema>;

// No Vega and no TV: a TV field is reached and typed through the focus engine,
// which has no way to replace a field's text. tvOS and Android TV share their
// platform with phones, so the handlers probe and refuse them before acting.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

export function createFillTool(registry: Registry): ToolDefinition<Params, FillResult> {
  const dispatch = dispatchByPlatform<
    Record<string, unknown>,
    Record<string, unknown>,
    FillParams,
    FillResult
  >({
    toolId: "fill",
    capability,
    ios: {
      requires: iosRequires,
      handler: async (_services, params, device) => {
        if (await isTvOsSimulator(device.id)) {
          throw new UnsupportedOperationError("fill", device, "tvOS");
        }
        return fillIos(registry, device, params.text);
      },
    },
    iosRemote: {
      requires: ["sim-remote"],
      handler: async (_services, params, device) => {
        if (await isRemoteTvOsSimulator(device.id)) {
          throw new UnsupportedOperationError("fill", device, "tvOS");
        }
        return fillIos(registry, device, params.text);
      },
    },
    iosDevice: {
      requires: ["xcrun"],
      handler: async (_services, params, device) => {
        // Nothing on a physical iPhone reads a field back.
        await fillByDeviceKeys(registry, device, params.text);
        return { verified: false };
      },
    },
    android: {
      requires: androidRequires,
      handler: async (_services, params, device) => {
        if (await isAndroidTv(device.id)) {
          throw new UnsupportedOperationError("fill", device, "Android TV");
        }
        return fillAndroid(registry, device, params.text);
      },
    },
    chromium: {
      handler: async (_services, params, device) => fillChromium(registry, device, params.text),
    },
  });

  return {
    id: "fill",
    interaction: {
      // Never quote `text`: it may be a credential, and these messages reach
      // the event log.
      startedMsg: () => "Filling the focused field",
      completedMsg: () => "Filled the focused field",
      failedMsg: ({ failureSignal }) => `Failed to fill the field: ${failureSignal.error_code}`,
    },
    description: `Set the text of the focused text field to exactly \`text\`, replacing what it holds; "" clears it. Tap the field first.
Returns { verified }, never the text: true when the field was read back holding the text, false on a physical iPhone, where nothing can read it back.
Fails with FILL_NO_FOCUSED_FIELD when nothing editable has focus, FILL_NOT_VERIFIED when the field does not read back the text, FILL_UNSUPPORTED_FIELD for a field that cannot take the text (a date or time input, a newline in a single-line field; nothing is changed). Fails if the device's ax-service or devtools helper predates fill; update argent. Not supported on TV targets or Vega.`,
    hideFromMcp: true,
    zodSchema,
    capability,
    services: () => ({}),
    execute: async (services, params, options) => {
      // Resolved here, after every logging boundary, as `keyboard` does.
      const { text, secrets } = resolveSecretPlaceholders(params.text);
      try {
        return await dispatch(services, { udid: params.udid, text }, options);
      } catch (err) {
        throw redactSecretsFromError(err, secrets);
      }
    },
  };
}

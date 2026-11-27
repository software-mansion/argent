import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";
import { RELEASE_DEVICE_TOOL_ID, claimKey, deviceClaims } from "../../utils/device-claims";

const zodSchema = z
  .object({
    udid: z
      .string()
      .optional()
      .describe("The device to release. Omit it to release every device of the session."),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

interface ReleaseDeviceResult {
  /** The devices this call released, by their udid or serial. */
  released: string[];
}

export const releaseDeviceTool: ToolDefinition<Params, ReleaseDeviceResult> = {
  id: RELEASE_DEVICE_TOOL_ID,
  description:
    "End this session's claim on a device, so that another session can drive it. Without udid, ends every claim of the session.",
  zodSchema,
  hideFromMcp: true,
  interaction: {
    startedMsg: () => "Releasing devices",
    completedMsg: ({ result }) =>
      `Released ${result.released.length} ${result.released.length === 1 ? "device" : "devices"}`,
    failedMsg: ({ failureSignal }) => `Failed to release devices: ${failureSignal.error_code}`,
  },
  services: () => ({}),
  async execute(_services, params, ctx) {
    if (!ctx?.session) {
      throw new InvalidToolInputError(
        "release-device needs a session. Set ARGENT_SESSION to the value the session used."
      );
    }
    const device = params.udid === undefined ? undefined : claimKey(params.udid);
    return { released: deviceClaims.release(ctx.session, device) };
  },
};

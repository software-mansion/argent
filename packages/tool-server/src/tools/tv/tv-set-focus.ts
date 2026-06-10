import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef, type TvControlApi } from "../../blueprints/tv-control";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Apple TV simulator UDID from `list-devices` (a device with runtimeKind 'tv')."),
  label: z
    .string()
    .min(1)
    .describe("Exact accessibility label of the focusable element to jump focus to (see `tv-describe`)."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  ok: boolean;
  message: string;
  label: string;
}

const tvSetFocusTool: ToolDefinition<Params, Result> = {
  id: "tv-set-focus",
  description: `Jump focus directly to a tvOS element by its accessibility label, skipping step-by-step \`tv-navigate\`.
Faster than D-pad traversal when you already know the target label from \`tv-describe\`, but less faithful to real remote use — prefer \`tv-navigate\` when validating actual navigation paths.
Returns { ok, message, label }. ok=false (with a message) when the label isn't found or the simulator doesn't have AutomationEnabled.
Requires a booted Apple TV simulator; fails for iOS/Android devices.`,
  searchHint: "tvos apple tv set focus jump element label accessibility teleport",
  zodSchema,
  services: (params) => ({
    tv: tvControlRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    const r = await api.setFocus(params.label);
    return { ok: r.ok, message: r.message, label: params.label };
  },
};

export { tvSetFocusTool };

import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { tvServiceRef } from "./tv-service";
import type { TvControlApi } from "../../blueprints/tv-control-types";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "TV target id from `list-devices` (a device with runtimeKind 'tv') — an Apple TV simulator UDID or an Android TV serial."
    ),
  label: z
    .string()
    .min(1)
    .describe(
      "Accessibility label of the focusable element to move focus to, as shown by `tv-describe` " +
        "(use the first line of a compound label — matching is case-insensitive with prefix/substring fallback)."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  ok: boolean;
  message: string;
  label: string;
}

const tvSetFocusTool: ToolDefinition<Params, Result> = {
  id: "tv-set-focus",
  description: `Move focus to a TV element by its accessibility label, skipping step-by-step \`tv-navigate\`.
On Apple TV this jumps focus directly (native setNativeFocus); on Android TV there is no jump primitive, so it walks the D-pad toward the target's on-screen position (best-effort, bounded) — prefer \`tv-navigate\` when validating an exact navigation path.
Returns { ok, message, label }. ok=false (with a message) when the label isn't on screen, focus can't reach it, or (Apple TV) the simulator lacks AutomationEnabled.
Requires a booted TV target (runtimeKind 'tv'); fails for phones/tablets.`,
  searchHint:
    "tvos apple tv android tv set focus jump element label accessibility teleport leanback dpad",
  zodSchema,
  services: (params) => ({
    tv: tvServiceRef(params.udid),
  }),
  async execute(services, params) {
    const api = services.tv as TvControlApi;
    const r = await api.setFocus(params.label);
    return { ok: r.ok, message: r.message, label: params.label };
  },
};

export { tvSetFocusTool };

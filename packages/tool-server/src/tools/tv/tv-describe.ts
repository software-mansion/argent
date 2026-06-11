import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef, type TvControlApi, type TvElement } from "../../blueprints/tv-control";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Apple TV simulator UDID from `list-devices` (a device with runtimeKind 'tv')."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  description: string;
  bundleId?: string;
  focusedLabel: string | null;
  focusableCount: number;
}

/**
 * tvOS AX labels are often compound multi-line strings, e.g.
 * "Home\nLander\nSide bar content item\n1 of 5\nselected". `tv-set-focus`
 * matches on the first line, so that is the label the agent should copy. Return
 * it as the actionable label and keep the remaining lines as compact context.
 */
function primaryLabel(label: string | undefined): string {
  if (!label) return "(no label)";
  const firstLine = label.split("\n")[0]?.trim();
  return firstLine && firstLine.length ? firstLine : "(no label)";
}

function fmtElement(e: TvElement): string {
  const traits = e.traits?.length ? ` [${e.traits.join(",")}]` : "";
  const value = e.value ? ` = "${e.value}"` : "";
  const label = primaryLabel(e.label);
  // Surface any extra lines of a compound label as dim context, so the agent
  // sees the full text but knows the first line is what `tv-set-focus` wants.
  const extraLines = (e.label ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  const context = extraLines.length ? ` (${extraLines.join(" · ")})` : "";
  return `${label}${value}${traits}${context}`;
}

/**
 * Render the tvOS focus state as text. Unlike iOS/Android there are no tap
 * coordinates to act on — the agent moves the focus engine with `tv-navigate`
 * (or jumps with `tv-set-focus`) and confirms with another `tv-describe`. So
 * the rendering centers on "what's focused" and "what can be focused".
 */
const tvDescribeTool: ToolDefinition<Params, Result> = {
  id: "tv-describe",
  description: `Read the on-screen accessibility state of a tvOS (Apple TV) simulator.
tvOS is focus-driven: there is no touch. This returns the currently FOCUSED element and the list of FOCUSABLE elements, so you can decide which direction to move.
Use it before and after every \`tv-navigate\` / \`tv-set-focus\` to see where focus landed and what changed.
Returns { description (text rendering), bundleId, focusedLabel, focusableCount }.
Requires a booted Apple TV simulator (boot one via boot-device); fails for iOS/Android devices — use \`describe\` for those.`,
  alwaysLoad: true,
  searchHint: "tvos apple tv describe focus focusable accessibility remote dpad television",
  zodSchema,
  services: (params) => ({
    tv: tvControlRef(resolveDevice(params.udid)),
  }),
  async execute(services) {
    const api = services.tv as TvControlApi;
    const res = await api.describe();

    const lines: string[] = [];
    if (res.bundleId) lines.push(`App: ${res.bundleId}`);
    lines.push(`Focused: ${res.focused ? fmtElement(res.focused) : "(none)"}`);
    if (res.focusable.length) {
      lines.push(`Focusable (${res.focusable.length}):`);
      for (const e of res.focusable) {
        const marker = e.isFocused ? "→ " : "  ";
        lines.push(`${marker}${fmtElement(e)}`);
      }
    } else {
      lines.push("Focusable: (none reported)");
    }

    return {
      description: lines.join("\n"),
      bundleId: res.bundleId,
      focusedLabel: res.focused?.label ? primaryLabel(res.focused.label) : null,
      focusableCount: res.focusable.length,
    };
  },
};

export { tvDescribeTool };

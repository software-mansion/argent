import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { suppressUpdateNote } from "../../utils/update-checker";

const zodSchema = z.object({
  hours: z.number().min(0).describe("Number of hours to suppress the update notification"),
});

export const dismissUpdateTool: ToolDefinition<{ hours: number }> = {
  id: "dismiss-update",
  description:
    "Clear the Argent update notification for the given number of hours. Use when the user asks to postpone or silence update reminders. Returns { message } confirming the suppression duration. Fails if the hours value is negative or the suppression state cannot be persisted.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, _options) {
    const durationMs = params.hours * 60 * 60 * 1000;
    suppressUpdateNote(durationMs);
    return {
      message:
        params.hours > 0
          ? `Update notification dismissed for ${params.hours} hour(s).`
          : "Update notification suppression cleared. The notification will appear on the next tool call if an update is still available.",
    };
  },
};

import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState, suppressUpdateNote } from "../../utils/update-checker";

// Ten years: a real answer to "never", and far inside what a Date can print.
const MAX_HOURS = 24 * 365 * 10;

const zodSchema = z.object({
  hours: z.number().min(0).describe("Number of hours to suppress the update notification"),
});

interface DismissUpdateResult {
  message: string;
  /** ISO 8601 end of the silence; null after `hours: 0`. */
  remindersResumeAt: string | null;
  /** False when ~/.argent could not be written: it holds only in this tool-server. */
  persisted: boolean;
  /** The version the reminder would offer, or null when nothing is pending. */
  pendingVersion: string | null;
}

export const dismissUpdateTool: ToolDefinition<{ hours: number }, DismissUpdateResult> = {
  id: "dismiss-update",
  description:
    "Clear the Argent update notification for a number of hours. Use when the user asks to postpone or silence update reminders. Returns { message } confirming the suppression duration. Fails if the suppression state cannot be persisted.",
  zodSchema,
  // The tool-server already suppresses the update note for 30 minutes each
  // time it shows it (http.ts), so agents need no call. `argent run` and the
  // SDK still call it.
  hideFromMcp: true,
  interaction: {
    startedMsg: () => "Dismissing Argent update",
    completedMsg: () => "Dismissed Argent update",
    failedMsg: ({ failureSignal }) =>
      `Failed to dismiss Argent update: ${failureSignal.error_code}`,
  },
  services: () => ({}),
  async execute(_services, params, _options) {
    const hours = Math.min(params.hours, MAX_HOURS);
    const { until, persisted } = suppressUpdateNote(hours * 60 * 60 * 1000);
    const { updateInstallable, installableVersion } = getUpdateState();
    const pendingVersion = updateInstallable ? installableVersion : null;
    const end = new Date(until);
    const local = end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

    if (hours === 0) {
      return {
        message: pendingVersion
          ? `Update reminders are back on, so the reminder for v${pendingVersion} shows again.`
          : "Update reminders are back on. No update is pending right now.",
        remindersResumeAt: null,
        persisted,
        pendingVersion,
      };
    }

    const pending = pendingVersion
      ? `v${pendingVersion} stays available and nothing was installed.`
      : `No update is pending right now; one that appears before then stays silent too.`;
    const scope = persisted
      ? `on every Argent tool-server on this machine`
      : `in this tool-server only, and only until it restarts: ~/.argent could not be written, so other tool-servers still show reminders`;
    return {
      message:
        `Update reminders are off until ${local} (${end.toISOString()}) ${scope}. ${pending} ` +
        `Tell the user when reminders resume. Remove any saved reminder about this update from your task list and do not bring it up again unless the user asks.`,
      remindersResumeAt: end.toISOString(),
      persisted,
      pendingVersion,
    };
  },
};

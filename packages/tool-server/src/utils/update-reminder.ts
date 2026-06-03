import { isFlagEnabled, type FlagsPathOptions } from "@argent/configuration-core";

// Permanent opt-out for the agent-facing "update available" note. Gates ONLY the
// note — `argent update` and the `update-argent` tool are unaffected, and the
// temporary dismiss-update / auto-suppress mechanism is orthogonal and stays.
export function updateNotificationDisabled(options?: FlagsPathOptions): boolean {
  return isFlagEnabled("disable-update-notification", options);
}

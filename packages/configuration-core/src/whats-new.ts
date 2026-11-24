import { getAtPath, readConfigObject, setAtPath, updateConfig } from "./config.js";
import type { ConfigPathOptions } from "./paths.js";

const WHATS_NEW_SEEN_KEY = "notices.whats_new_seen";

/** The Argent version whose release highlights the agent last received, or null. */
export function getWhatsNewSeenVersion(options: ConfigPathOptions = {}): string | null {
  const value = getAtPath(readConfigObject("global", options), WHATS_NEW_SEEN_KEY);
  return typeof value === "string" ? value : null;
}

export function setWhatsNewSeenVersion(version: string, options: ConfigPathOptions = {}): void {
  updateConfig((config) => setAtPath(config, WHATS_NEW_SEEN_KEY, version), "global", options);
}

import { getAtPath, readConfigObject, setAtPath, updateConfig } from "./config.js";
import type { ConfigPathOptions } from "./paths.js";

const WHATS_NEW_SEEN_KEY = "notices.whats_new_seen";

/** The Argent version whose release highlights the agent last received, or null. */
export function getWhatsNewSeenVersion(options: ConfigPathOptions = {}): string | null {
  const value = getAtPath(readConfigObject("global", options), WHATS_NEW_SEEN_KEY);
  return typeof value === "string" ? value : null;
}

export function setWhatsNewSeenVersion(
  version: string,
  options: ConfigPathOptions & { ifSeen?: string | null } = {}
): boolean {
  let recorded = false;
  updateConfig(
    (config) => {
      // Two editors can make their first call together. Check under the config
      // lock so only one claims these highlights and an older reader cannot rewind it.
      const value = getAtPath(config, WHATS_NEW_SEEN_KEY);
      const seen = typeof value === "string" ? value : null;
      if (options.ifSeen !== undefined && options.ifSeen !== seen) return;
      setAtPath(config, WHATS_NEW_SEEN_KEY, version);
      recorded = true;
    },
    "global",
    options
  );
  return recorded;
}

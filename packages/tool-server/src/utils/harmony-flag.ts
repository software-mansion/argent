import { isFlagEnabled } from "@argent/configuration-core";

export const HARMONY_FLAG = "harmonyos";

export const HARMONY_DISABLED_REASON =
  "HarmonyOS support is off; turn it on with `argent enable harmonyos`";

/** Read per call, so `argent enable/disable harmonyos` needs no tool-server restart. */
export function isHarmonyEnabled(): boolean {
  return isFlagEnabled(HARMONY_FLAG);
}

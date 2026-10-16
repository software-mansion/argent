import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import type {
  Appearance,
  SetAppearanceParams,
  SetAppearanceResult,
  SetAppearanceServices,
} from "../types";

/** `cmd uimode night` prints `Night mode: yes` (or `no`, `auto`, `custom`). */
export function parseNightMode(stdout: string): string | null {
  return /night mode:\s*(\S+)/i.exec(stdout)?.[1]?.toLowerCase() ?? null;
}

function toAppearance(nightMode: string | null): Appearance | null {
  if (nightMode === "yes") return "dark";
  if (nightMode === "no") return "light";
  return null;
}

/**
 * `cmd uimode night yes|no` — the system dark theme (Settings ▸ Display ▸ Dark
 * theme). It reports the new mode on success, but on a failure it can print an
 * error and still exit 0, so the reply is read back rather than trusted.
 */
export const androidImpl: PlatformImpl<
  SetAppearanceServices,
  SetAppearanceParams,
  SetAppearanceResult
> = {
  requires: ["adb"],
  async handler(_services, params): Promise<SetAppearanceResult> {
    const { udid, appearance } = params;
    const previous = toAppearance(parseNightMode(await adbShell(udid, "cmd uimode night")));
    const wanted = appearance === "dark" ? "yes" : "no";
    const reply = await adbShell(udid, `cmd uimode night ${wanted}`);
    const now = parseNightMode(reply);
    if (now !== wanted) {
      throw new FailureError(
        `Failed to set the appearance of ${udid} to ${appearance}: \`cmd uimode night ${wanted}\` replied ${JSON.stringify(reply.trim())}.`,
        {
          error_code: FAILURE_CODES.ANDROID_APPEARANCE_FAILED,
          failure_stage: "android_appearance_uimode",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }
      );
    }
    return { appearance, previous };
  },
};

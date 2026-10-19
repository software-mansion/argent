import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type {
  Appearance,
  SetAppearanceParams,
  SetAppearanceResult,
  SetAppearanceServices,
} from "../types";

const execFileAsync = promisify(execFile);

function appearanceFailure(udid: string, detail: string, cause?: Error): FailureError {
  // `simctl ui` on a shut-down simulator says "Unable to lookup in current
  // state: Shutdown", which does not say what to do next.
  const shutdownHint = /current state:\s*shutdown|unable to lookup|device is not booted/i.test(
    detail
  )
    ? " The simulator must be booted first — use boot-device."
    : "";
  return new FailureError(
    `Failed to set the appearance of ${udid}: ${detail.trim()}${shutdownHint}`,
    {
      error_code: FAILURE_CODES.IOS_APPEARANCE_FAILED,
      failure_stage: "ios_appearance_simctl_ui",
      failure_area: "tool_server",
      error_kind: "subprocess",
      ...(cause ? subprocessFailureMetadata(cause, "xcrun_simctl") : {}),
    },
    cause ? { cause } : undefined
  );
}

async function simctlUi(udid: string, args: string[]): Promise<string> {
  const argv = await simctlArgsForUdid(udid, ["ui", udid, "appearance", ...args]);
  try {
    const { stdout } = await execFileAsync("xcrun", argv, { timeout: 15_000 });
    return String(stdout).trim();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw appearanceFailure(udid, error.message, error);
  }
}

/**
 * `xcrun simctl ui <udid> appearance [light|dark]` — the same switch as
 * Settings ▸ Developer ▸ Dark Appearance. Without a value simctl prints the
 * current one, or `unsupported` on a runtime with no dark mode (before iOS 13).
 */
export const iosImpl: PlatformImpl<
  SetAppearanceServices,
  SetAppearanceParams,
  SetAppearanceResult
> = {
  requires: ["xcrun"],
  async handler(_services, params): Promise<SetAppearanceResult> {
    const { udid, appearance } = params;
    const current = await simctlUi(udid, []);
    if (current === "unsupported") {
      throw appearanceFailure(
        udid,
        "this simulator's runtime has no light/dark appearance (it needs iOS 13 or later)."
      );
    }
    await simctlUi(udid, [appearance]);
    const previous: Appearance | null = current === "light" || current === "dark" ? current : null;
    return { appearance, previous };
  },
};

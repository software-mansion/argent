import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import { resolveRunnerSigningConfig } from "../../../utils/ios-device/runner-build";
import {
  isSessionOnlySystemUi,
  setCurrentIosDeviceApp,
} from "../../../utils/ios-device/app-session";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Latency bound for the post-launch signing probe. Resolution is the env var
 * or the process-memoized keychain detection, so only the first probe in a
 * process can pay a `security` shellout; a wedged keychain must not gate the
 * launch result, so a slow first probe reports nothing and the next runner
 * tool call tells the full story.
 */
const SIGNING_PROBE_TIMEOUT_MS = 1_500;

/** First sentence only: the full error returns when a runner tool call actually fails. */
function firstSentence(message: string): string {
  return message.match(/^[^.]*\./)?.[0] ?? message;
}

/**
 * launch-app goes through devicectl and succeeds with unready signing; the
 * very next interaction tool would then fail building the XCUITest runner.
 * This probe pre-announces that: it only resolves the signing config (env
 * var, else memoized keychain detection), and never triggers a build.
 */
async function signingUnreadyNote(): Promise<string | undefined> {
  const failure = await Promise.race([
    resolveRunnerSigningConfig().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    ),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), SIGNING_PROBE_TIMEOUT_MS).unref()
    ),
  ]);

  return failure === null ? undefined : `Runner signing is not ready: ${firstSentence(failure)}`;
}

/**
 * Launch an app on a physical iOS device with devicectl.
 */
export const iosDeviceImpl: PlatformImpl<
  Record<string, unknown>,
  LaunchAppParams,
  LaunchAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await ensureDeviceReady(params.udid);

    // System UI is always running. Register the session only. Do not launch.
    if (!isSessionOnlySystemUi(params.bundleId)) {
      await launchApp(params.udid, params.bundleId);
    }

    setCurrentIosDeviceApp(params.udid, params.bundleId);

    const note = await signingUnreadyNote();

    return {
      launched: true,
      bundleId: params.bundleId,
      ...(note ? { note } : {}),
    };
  },
};

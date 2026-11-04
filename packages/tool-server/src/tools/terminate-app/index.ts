import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import { simctlArgsForUdid } from "../../utils/ios-device-sets";
import { remoteSimctl } from "../../utils/simctl-backend";
import { adbShell, shellQuote } from "../../utils/adb";
import { vegaDevice } from "../../utils/vega-cli";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe("App identifier. iOS: bundle id. Android: package name."),
});

type Params = z.infer<typeof zodSchema>;
type TerminateAppResult = { terminated: boolean; bundleId: string };

// The same kill steps restart-app runs, kept here on purpose so restart-app is
// unchanged. Physical iPhones have no standalone kill step yet (restart-app
// relaunches with terminate-existing), so `apple.device` is left out and rejected.
const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

// simctl answers the same for an app that is not running and one that is not installed.
const SIMCTL_NOTHING_TO_TERMINATE = /found nothing to terminate/i;
// The vega CLI's error for an app that is not installed.
const VEGA_NOT_INSTALLED = /App could not be determined/i;

async function tolerateNothingToTerminate(
  terminate: Promise<unknown>,
  nothingToTerminate: RegExp
): Promise<boolean> {
  try {
    await terminate;
    return true;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    if (nothingToTerminate.test(`${e.stderr ?? ""} ${e.message ?? ""}`)) return false;
    throw err;
  }
}

export const terminateAppTool: ToolDefinition<Params, TerminateAppResult> = {
  id: "terminate-app",
  interaction: {
    startedMsg: ({ params }) => `Terminating ${params.bundleId}`,
    completedMsg: ({ params }) => `Terminated ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to terminate ${params.bundleId}: ${failureSignal.error_code}`,
  },
  description: `Stop a running app without relaunching it, for SDK callers.
Use when a program needs the app closed between steps; agents use restart-app.
Returns { terminated, bundleId }; terminated is false on iOS when the app was not running.
Succeeds when the app is not running or not installed.`,
  hideFromMcp: true,
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform({
    toolId: "terminate-app",
    capability,
    ios: {
      requires: ["xcrun"],
      handler: async (_services, { udid, bundleId }) => {
        // Built outside the tolerance so a provider's entitlement denial still throws.
        const args = await simctlArgsForUdid(udid, ["terminate", udid, bundleId]);
        const terminated = await tolerateNothingToTerminate(
          execFileAsync("xcrun", args),
          SIMCTL_NOTHING_TO_TERMINATE
        );
        return { terminated, bundleId };
      },
    },
    iosRemote: {
      requires: ["sim-remote"],
      handler: async (_services, { udid, bundleId }) => {
        const terminated = await tolerateNothingToTerminate(
          remoteSimctl.terminate(udid, bundleId),
          SIMCTL_NOTHING_TO_TERMINATE
        );
        return { terminated, bundleId };
      },
    },
    android: {
      requires: ["adb"],
      handler: async (_services, { udid, bundleId }) => {
        // force-stop exits 0 for a stopped or unknown package, so this is always true.
        await adbShell(udid, `am force-stop ${shellQuote(bundleId)}`, { timeoutMs: 15_000 });
        return { terminated: true, bundleId };
      },
    },
    vega: {
      requires: ["vega"],
      handler: async (_services, { udid, bundleId }) => {
        // Always true, as on Android: the CLI exits 0 for a running or stopped app and
        // errors on one that is not installed.
        await tolerateNothingToTerminate(
          vegaDevice(udid, ["terminate-app", "-a", bundleId], { timeoutMs: 40_000 }),
          VEGA_NOT_INSTALLED
        );
        return { terminated: true, bundleId };
      },
    },
  }),
};

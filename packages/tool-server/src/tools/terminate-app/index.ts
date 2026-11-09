import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import { simctlArgsForUdid } from "../../utils/ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../../utils/simctl-config";
import {
  remoteSimctl,
  SIMCTL_NOTHING_TO_TERMINATE,
  tolerateNothingToTerminate,
} from "../../utils/simctl-backend";
import { adbShell, shellQuote } from "../../utils/adb";
import { vegaDevice } from "../../utils/vega-cli";

const execFileAsync = promisify(execFile);

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

// The vega CLI's error for an app that is not installed.
const VEGA_NOT_INSTALLED = /App could not be determined/i;

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe("App identifier. iOS: bundle id. Android: package name."),
});

type Params = z.infer<typeof zodSchema>;

export const terminateAppTool: ToolDefinition<Params, TerminateAppResult> = {
  id: "terminate-app",
  description: `Stop a running app without relaunching it, for SDK callers.
Use when a program needs the app closed between steps; agents use restart-app.
Returns { terminated, bundleId }; terminated is false on iOS when the app was not running.
Succeeds when the app is not running or not installed.`,
  zodSchema,
  hideFromMcp: true,
  interaction: {
    startedMsg: ({ params }) => `Terminating ${params.bundleId}`,
    completedMsg: ({ params }) => `Terminated ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to terminate ${params.bundleId}: ${failureSignal.error_code}`,
  },
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
        const terminate = execFileAsync("xcrun", args, {
          timeout: 15_000,
          killSignal: SIMCTL_KILL_SIGNAL,
        }).catch((err: unknown) => {
          if (!(err as { killed?: boolean }).killed) throw err;
          throw new FailureError(
            `Terminating iOS app ${bundleId} on ${udid} did not finish within 15s.`,
            {
              error_code: FAILURE_CODES.IOS_TERMINATE_APP_FAILED,
              failure_stage: "ios_terminate_app_simctl_terminate",
              failure_area: "tool_server",
              error_kind: "timeout",
              ...subprocessFailureMetadata(err, "xcrun_simctl"),
            },
            { cause: err as Error }
          );
        });
        const terminated = await tolerateNothingToTerminate(terminate, SIMCTL_NOTHING_TO_TERMINATE);
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

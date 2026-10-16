import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError, UnsupportedOperationError } from "../../../utils/capability";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import { getSimulatorRuntimeKind } from "../../../utils/ios-devices";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "../../../utils/simctl-config";
import { IOS_SUPPORTED_SETTINGS } from "../types";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

const execFileAsync = promisify(execFile);

// `defaults` keys live in com.apple.Accessibility; the runtime posts the change
// notifications itself once a key is written.
type IosMechanism =
  | { via: "simctl-ui"; option: string; arg: string }
  | { via: "defaults"; key: string; enabled: boolean };

const ACCESSIBILITY_DOMAIN = "com.apple.Accessibility";

function iosMechanism(setting: SystemSetting, value: string): IosMechanism {
  switch (setting) {
    case "appearance":
      return { via: "simctl-ui", option: "appearance", arg: value };
    case "text-size":
      return { via: "simctl-ui", option: "content_size", arg: value };
    case "increase-contrast":
      return {
        via: "simctl-ui",
        option: "increase_contrast",
        arg: value === "on" ? "enabled" : "disabled",
      };
    case "reduce-motion":
      return { via: "defaults", key: "ReduceMotionEnabled", enabled: value === "on" };
    case "invert-colors":
      // Classic Invert. `ClassicInvertColorsEnabled` looks right but nothing reads it.
      return { via: "defaults", key: "InvertColorsEnabled", enabled: value === "on" };
    default:
      throw new Error(`No iOS mechanism for setting '${setting}'`);
  }
}

function throwIosSettingError(
  setting: SystemSetting,
  value: string,
  udid: string,
  err: unknown,
  failureStage = "ios_system_setting_apply",
  runtimeOptionApplies = true
): never {
  const detail = err instanceof Error ? err.message : String(err);
  const timedOut = (err as { killed?: boolean } | null)?.killed === true;
  const timeoutHint = timedOut
    ? " simctl was killed after its timeout — CoreSimulatorService is likely wedged."
    : "";
  // `simctl ui` says "current state: Shutdown|Booting", `simctl spawn` "not booted".
  const bootHint = /current state:\s*shutdown|not booted/i.test(detail)
    ? " The simulator must be booted first — use boot-device."
    : /current state:\s*booting/i.test(detail)
      ? " The simulator is still booting — wait for it to finish, then retry."
      : "";
  // A runtime lacking the option says "not supported"; a bad argument says
  // "Invalid argument", which a newer runtime would not fix.
  const unsupportedHint =
    runtimeOptionApplies && !bootHint && /unsupported|not support/i.test(detail)
      ? ` The '${setting}' setting isn't supported by this simulator's iOS runtime; try a newer runtime.`
      : "";
  throw new FailureError(
    `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}${timeoutHint}${bootHint}${unsupportedHint}`,
    {
      error_code: FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED,
      failure_stage: failureStage,
      failure_area: "tool_server",
      error_kind: timedOut ? "timeout" : "subprocess",
      ...subprocessFailureMetadata(err, "xcrun_simctl"),
    },
    { cause: err instanceof Error ? err : new Error(String(err)) }
  );
}

export const iosImpl: PlatformImpl<
  SystemSettingsServices,
  SystemSettingsParams,
  SystemSettingsResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    const { udid, setting, value } = params;

    if (!IOS_SUPPORTED_SETTINGS.includes(setting)) {
      throw new InvalidToolInputError(
        `The '${setting}' system setting can't be changed on the iOS simulator — it's Android-only ` +
          `(the simulator exposes no toggle for the radios, the location master switch, or rotation lock). ` +
          `iOS-supported settings: ${IOS_SUPPORTED_SETTINGS.join(", ")}.`,
        {
          error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
          failure_stage: "ios_system_setting_unsupported",
          error_kind: "unsupported",
        }
      );
    }

    // An Apple TV simulator passes the capability gate, and the `defaults`
    // writes succeed there without changing the screen. Require a positive iOS
    // answer: the probe returns undefined when `simctl list` fails.
    const runtimeKind = await getSimulatorRuntimeKind(udid);
    if (runtimeKind !== "mobile") {
      throw new UnsupportedOperationError(
        "system-settings",
        device,
        runtimeKind === "tv"
          ? "neither mechanism reaches tvOS — `simctl ui` refuses every option there, and the accessibility preferences are written but never honoured"
          : `\`simctl list\` does not report ${udid} as an available iOS simulator, so this cannot confirm the target is one — run \`list-devices\` to check it exists and is available`
      );
    }

    const mechanism = iosMechanism(setting, value);

    if (mechanism.via === "simctl-ui") {
      let stderr = "";
      try {
        ({ stderr } = await execFileAsync(
          "xcrun",
          await simctlArgsForUdid(udid, ["ui", udid, mechanism.option, mechanism.arg]),
          { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
        ));
      } catch (err) {
        throwIosSettingError(setting, value, udid, err);
      }
      // `simctl ui` can refuse on stderr with exit 0.
      if (stderr.trim()) {
        throwIosSettingError(
          setting,
          value,
          udid,
          new Error(stderr.trim()),
          "ios_system_setting_refused"
        );
      }
      return { setting, value, applied: `${mechanism.option}=${mechanism.arg}` };
    }

    const boolArg = mechanism.enabled ? "YES" : "NO";
    try {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(udid, [
          "spawn",
          udid,
          "defaults",
          "write",
          ACCESSIBILITY_DOMAIN,
          mechanism.key,
          "-bool",
          boolArg,
        ]),
        { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
      );
    } catch (err) {
      throwIosSettingError(setting, value, udid, err, "ios_system_setting_apply", false);
    }
    return { setting, value, applied: `${mechanism.key}=${boolArg}` };
  },
};

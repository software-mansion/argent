import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { IOS_SUPPORTED_SETTINGS } from "../types";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

const execFileAsync = promisify(execFile);

// How the iOS simulator applies each setting it supports. Two mechanisms:
//  - `simctl ui`: the three options a runtime models natively. The value is the
//    exact `simctl ui` argument (light/dark and the content-size categories are
//    simctl's own vocabulary; `increase_contrast` takes enabled/disabled, so the
//    tool's on/off maps to those).
//  - `defaults`: accessibility toggles that live in the `com.apple.Accessibility`
//    preferences domain. Writing the key persists the setting; posting the
//    matching change notification makes running apps re-read it without a full
//    respring.
type IosMechanism =
  | { via: "simctl-ui"; option: string; arg: string }
  | { via: "defaults"; key: string; notify: string; enabled: boolean };

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
      return {
        via: "defaults",
        key: "ReduceMotionEnabled",
        notify: `${ACCESSIBILITY_DOMAIN}.ReduceMotionStatusDidChange`,
        enabled: value === "on",
      };
    case "invert-colors":
      return {
        via: "defaults",
        key: "ClassicInvertColorsEnabled",
        notify: `${ACCESSIBILITY_DOMAIN}.InvertColorsStatusDidChange`,
        enabled: value === "on",
      };
    default:
      // Unreachable: the handler rejects non-iOS settings before this is called.
      throw new Error(`No iOS mechanism for setting '${setting}'`);
  }
}

function throwIosSettingError(
  setting: SystemSetting,
  value: string,
  udid: string,
  err: unknown
): never {
  const detail = err instanceof Error ? err.message : String(err);
  // `simctl ui` and `simctl spawn` both require a booted simulator but word the
  // refusal differently — `ui` answers "Unable to lookup in current state:
  // Shutdown", `spawn` "Process spawn via launchd failed because device is not
  // booted." Neither tells an agent what to do about it, so match both.
  const shutdownHint = /current state:\s*shutdown|not booted/i.test(detail)
    ? " The simulator must be booted first — use boot-device."
    : "";
  // A `simctl ui` option the runtime doesn't model refuses the argument rather
  // than naming the option: `content_size` and `increase_contrast` answer
  // "Invalid argument". Central validation already pinned `value` to the
  // setting's own enum, so a refusal that reaches here is about the runtime.
  const unsupportedHint =
    !shutdownHint && /unsupported|invalid argument/i.test(detail)
      ? ` The '${setting}' setting isn't supported by this simulator's iOS runtime; try a newer runtime.`
      : "";
  throw new FailureError(
    `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}${shutdownHint}${unsupportedHint}`,
    {
      error_code: FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED,
      failure_stage: "ios_system_setting_apply",
      failure_area: "tool_server",
      error_kind: "subprocess",
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
  handler: async (_services, params) => {
    const { udid, setting, value } = params;

    if (!IOS_SUPPORTED_SETTINGS.includes(setting)) {
      // Radios / location / rotation have no `simctl` equivalent — the iOS
      // simulator can't change them. Reject as caller input (400), matching the
      // invalid-value path, so the agent redirects instead of retrying.
      throw new InvalidToolInputError(
        `The '${setting}' system setting can't be changed on the iOS simulator — it's Android-only ` +
          `(the simulator has no host-side control over radios, location, or rotation). ` +
          `iOS-supported settings: ${IOS_SUPPORTED_SETTINGS.join(", ")}.`,
        {
          error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
          failure_stage: "ios_system_setting_unsupported",
        }
      );
    }

    const mechanism = iosMechanism(setting, value);

    if (mechanism.via === "simctl-ui") {
      let stderr = "";
      try {
        ({ stderr } = await execFileAsync(
          "xcrun",
          ["simctl", "ui", udid, mechanism.option, mechanism.arg],
          { timeout: 30_000 }
        ));
      } catch (err) {
        throwIosSettingError(setting, value, udid, err);
      }
      // Applying an option is silent, but only `appearance` also exits non-zero
      // when it refuses one: `content_size` and `increase_contrast` print
      // "Invalid argument" on stderr and still exit 0, which is what a runtime
      // that doesn't model the option produces. Trusting the exit code alone
      // would report `applied` for a setting that never changed.
      if (stderr.trim()) {
        throwIosSettingError(setting, value, udid, new Error(stderr.trim()));
      }
      return { setting, value, applied: `${mechanism.option}=${mechanism.arg}` };
    }

    // defaults: persist the accessibility flag, then post its change
    // notification so a running app re-reads it live.
    const boolArg = mechanism.enabled ? "YES" : "NO";
    try {
      await execFileAsync(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "defaults",
          "write",
          ACCESSIBILITY_DOMAIN,
          mechanism.key,
          "-bool",
          boolArg,
        ],
        { timeout: 30_000 }
      );
    } catch (err) {
      throwIosSettingError(setting, value, udid, err);
    }
    // Best-effort live-apply: posting the notification is not the source of
    // truth (the `defaults write` above is), and a runtime that doesn't observe
    // it still picks the change up on the app's next launch — so a failure here
    // must not fail the tool.
    try {
      await execFileAsync(
        "xcrun",
        ["simctl", "spawn", udid, "notifyutil", "-p", mechanism.notify],
        {
          timeout: 10_000,
        }
      );
    } catch {
      // ignore — the setting is already persisted; see comment above.
    }
    return { setting, value, applied: `${mechanism.key}=${boolArg}` };
  },
};

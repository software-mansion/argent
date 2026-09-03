import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError, UnsupportedOperationError } from "../../../utils/capability";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "../../../utils/simctl-config";
import { IOS_SUPPORTED_SETTINGS } from "../types";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

const execFileAsync = promisify(execFile);

/** Ceiling for `xcrun simctl ui`, which drives CoreSimulatorService rather than
 * spawning inside the guest. Same wedged-service hazard as
 * `SIMCTL_SPAWN_TIMEOUT_MS`, so it carries `SIMCTL_KILL_SIGNAL` too. */
const SIMCTL_UI_TIMEOUT_MS = 30_000;

// How the iOS simulator applies each setting it supports. Two mechanisms:
//  - `simctl ui`: the three options a runtime models natively. The value is the
//    exact `simctl ui` argument (light/dark and the content-size categories are
//    simctl's own vocabulary; `increase_contrast` takes enabled/disabled, so the
//    tool's on/off maps to those).
//  - `defaults`: accessibility toggles that live in the `com.apple.Accessibility`
//    preferences domain. Writing the key is the whole change — the runtime posts
//    the matching `com.apple.accessibility.*` status and cache notifications
//    itself once the preference lands, so running apps re-read it live.
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
      // `InvertColorsEnabled` is the key libAccessibility reads; it drives Smart
      // Invert, the only inversion control iOS exposes. The obvious-looking
      // `ClassicInvertColorsEnabled` appears nowhere in the runtime, so writing
      // that one persists a preference nothing observes.
      return { via: "defaults", key: "InvertColorsEnabled", enabled: value === "on" };
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
  // "Invalid argument", `appearance` "Operation not supported". Central
  // validation already pinned `value` to the setting's own enum, so a refusal
  // that reaches here is about the runtime.
  const unsupportedHint =
    !shutdownHint && /unsupported|not support|invalid argument/i.test(detail)
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
  handler: async (_services, params, device) => {
    const { udid, setting, value } = params;

    // An Apple TV simulator is an apple/simulator by UDID shape, so the
    // capability matrix cannot exclude it — and half this surface would answer
    // `applied` on one: tvOS refuses every `simctl ui` option ("Operation not
    // supported") but accepts the two `defaults` writes against a runtime with
    // no Settings pane to honour them.
    if (await isTvOsSimulator(udid)) {
      throw new UnsupportedOperationError(
        "system-settings",
        device,
        "tvOS models none of these system settings — appearance, text size and increase contrast are unsupported there and the accessibility preferences have no effect"
      );
    }

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
          error_kind: "unsupported",
        }
      );
    }

    const mechanism = iosMechanism(setting, value);

    if (mechanism.via === "simctl-ui") {
      let stderr = "";
      try {
        ({ stderr } = await execFileAsync(
          "xcrun",
          await simctlArgsForUdid(udid, ["ui", udid, mechanism.option, mechanism.arg]),
          { timeout: SIMCTL_UI_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
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
      throwIosSettingError(setting, value, udid, err);
    }
    return { setting, value, applied: `${mechanism.key}=${boolArg}` };
  },
};

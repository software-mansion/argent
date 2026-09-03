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
 * spawning inside the guest — the same wedged-service hazard as
 * `SIMCTL_SPAWN_TIMEOUT_MS`, so the same ceiling and `SIMCTL_KILL_SIGNAL`.
 *
 * It is also this handler's long pole: the dependency check, the tvOS probe and
 * this call run in series, and that sum has to stay under the MCP client's 30s
 * per-attempt cap. Above it the client aborts and replays the whole call while
 * the abandoned `simctl` keeps running, and the tool's own diagnostic — which
 * says what to do about a shut-down simulator — never reaches the agent.
 *
 * With `ios.additionalDeviceSets` configured, `simctlArgsForUdid` adds one
 * serial `simctl list` per set whenever the tvOS probe's own listing did not
 * find the UDID — which is exactly the wedged-service case, since that listing
 * fails closed. The budget cannot absorb those, and they are a property of the
 * shared device-set resolution rather than of this tool. */
export const SIMCTL_UI_TIMEOUT_MS = SIMCTL_SPAWN_TIMEOUT_MS;

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
      // `InvertColorsEnabled` is the key libAccessibility reads for Smart
      // Invert. The obvious-looking `ClassicInvertColorsEnabled` is no key at
      // all — the runtime carries it only inside symbol names, and spells the
      // classic-invert preference `AXSClassicInvertColorsPreference` — so
      // writing it persists something nothing observes.
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
  // A runtime that doesn't model an option exits 45 with "Operation not
  // supported" and a line naming what is missing ("Runtime does not support
  // userInterfaceStyle" / "…dynamic text" / "…increased contrast"). simctl's
  // other refusal — an argument outside its own vocabulary — words itself
  // differently ("Invalid argument", "Unknown apperance: …"), so matching only
  // the support wording keeps this hint off a case a newer runtime wouldn't fix.
  const unsupportedHint =
    !shutdownHint && /unsupported|not support/i.test(detail)
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
    // `applied` on one. tvOS has its own Appearance, Increase Contrast, Invert
    // Colors and Reduce Motion panes, but neither mechanism reaches them: every
    // `simctl ui` option is refused, and the two `defaults` writes land in the
    // domain and read back while the screen never changes.
    if (await isTvOsSimulator(udid)) {
      throw new UnsupportedOperationError(
        "system-settings",
        device,
        "neither mechanism reaches tvOS — `simctl ui` refuses every option there, and the accessibility preferences are written but never honoured"
      );
    }

    if (!IOS_SUPPORTED_SETTINGS.includes(setting)) {
      // Radios / location / rotation have no `simctl` equivalent — the iOS
      // simulator can't change them. Reject as caller input (400), matching the
      // invalid-value path, so the agent redirects instead of retrying.
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
      // `simctl ui` has a refusal that leaves the exit code at 0 and writes to
      // stderr instead — `content_size gigantic` answers "Invalid argument" that
      // way. Central validation pins `value` to simctl's own vocabulary, so no
      // request should reach it, which is exactly why the exit code alone is not
      // the success signal: the one channel that would report a change the
      // simulator never made is the one nothing else watches.
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

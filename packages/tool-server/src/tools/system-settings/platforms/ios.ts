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

/** Ceiling for `xcrun simctl ui`, which drives CoreSimulatorService rather than
 * spawning inside the guest — the same wedged-service hazard as
 * `SIMCTL_SPAWN_TIMEOUT_MS`, so the same ceiling and `SIMCTL_KILL_SIGNAL`.
 *
 * The dependency check, the runtime probe and this call run in series, and that
 * sum has to stay under the MCP client's 30s per-attempt cap. Above it the
 * client aborts and replays the whole call while the abandoned `simctl` keeps
 * running, and the tool's own diagnostic — which says what to do about a
 * shut-down simulator — never reaches the agent.
 *
 * `ios.additionalDeviceSets` costs nothing extra here: `simctlArgsForUdid`
 * probes a set only for a UDID with no device-set entry, and the listings that
 * can answer "mobile" for the runtime check record one for every simulator they
 * see. A UDID none of them saw is rejected before reaching this call. */
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
  err: unknown,
  failureStage = "ios_system_setting_apply"
): never {
  const detail = err instanceof Error ? err.message : String(err);
  // `execFile` reports its own timeout as an ordinary failed child it killed,
  // with nothing on either stream — the one failure these ceilings exist to
  // catch, and the only sign of it is the kill. The Android leg reads the same
  // shape the same way, so a wedged service lands in one bucket, not two.
  const timedOut = (err as { killed?: boolean } | null)?.killed === true;
  const timeoutHint = timedOut
    ? " simctl was killed after its timeout — CoreSimulatorService is likely wedged."
    : "";
  // `simctl ui` and `simctl spawn` both require a booted simulator but word the
  // refusal differently — `ui` answers "Unable to lookup in current state:
  // Shutdown", `spawn` "Process spawn via launchd failed because device is not
  // booted." Neither tells an agent what to do about it, so match both.
  const shutdownHint = /current state:\s*shutdown|not booted/i.test(detail)
    ? " The simulator must be booted first — use boot-device."
    : "";
  // A runtime that doesn't model an option exits 45 with "Operation not
  // supported" and a line naming what is missing — the iOS CoreSimulatorBridge
  // carries "Runtime does not support userInterfaceStyle" and "…dynamic text".
  // simctl's other refusal — an argument outside its own vocabulary — words
  // itself differently ("Invalid argument", "Unknown apperance: …"), so matching
  // only the support wording keeps this hint off a case a newer runtime
  // wouldn't fix.
  const unsupportedHint =
    !shutdownHint && /unsupported|not support/i.test(detail)
      ? ` The '${setting}' setting isn't supported by this simulator's iOS runtime; try a newer runtime.`
      : "";
  throw new FailureError(
    `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}${timeoutHint}${shutdownHint}${unsupportedHint}`,
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
      // Radios / location / rotation have no `simctl` equivalent — the iOS
      // simulator can't change them. Reject as caller input (400), matching the
      // invalid-value path, so the agent redirects instead of retrying. Decided
      // locally, so it runs before the runtime probe pays for a `simctl list`.
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

    // An Apple TV simulator is an apple/simulator by UDID shape, so the
    // capability matrix cannot exclude it — and half this surface would answer
    // `applied` on one. tvOS has its own Appearance, Increase Contrast, Invert
    // Colors and Reduce Motion panes, but neither mechanism reaches them: every
    // `simctl ui` option is refused, and the two `defaults` writes land in the
    // domain and read back while the screen never changes.
    //
    // Hence a positive "iOS" verdict, not the absence of a "tvOS" one: the
    // listing behind it answers `undefined` for a `simctl list` that failed or
    // came back unparseable, and for every Apple runtime that is neither iOS nor
    // tvOS. On any of those the `defaults` writes land, read back, and report
    // `applied` for a screen that never changed.
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
        // simctl exited 0, so this is the simulator's own refusal rather than a
        // subprocess fault — its own bucket, matching how the Android arm keeps
        // a device refusal apart from an adb failure.
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
      throwIosSettingError(setting, value, udid, err);
    }
    return { setting, value, applied: `${mechanism.key}=${boolArg}` };
  },
};

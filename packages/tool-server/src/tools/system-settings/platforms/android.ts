import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { FailureSignal } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, isAdbTransportFailure, runAdb, ENRICH_TIMEOUT_MS } from "../../../utils/adb";
import { InvalidToolInputError } from "../../../utils/capability";
import { isWirelessAdbSerial } from "../../../utils/device-info";
import { TEXT_SIZE_VALUES } from "../types";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

// appearance → `cmd uimode night <mode>` (the immediate, applies-now switch for
// the system dark/light theme).
const NIGHT_MODE: Record<string, string> = { light: "no", dark: "yes" };

// text-size → a `system.font_scale` float. iOS names 12 Dynamic Type categories
// where Android takes a continuous multiplier, so each category maps to the
// scale factor of that category's body-text point size relative to `large`
// (17pt) — iOS body sizes 14/15/16/17/19/21/23 then the AX range 28/33/40/47/53.
// This keeps the visual step between categories close to what iOS renders.
const FONT_SCALE: Record<(typeof TEXT_SIZE_VALUES)[number], string> = {
  "extra-small": "0.82",
  "small": "0.88",
  "medium": "0.94",
  "large": "1.0",
  "extra-large": "1.12",
  "extra-extra-large": "1.24",
  "extra-extra-extra-large": "1.35",
  "accessibility-medium": "1.65",
  "accessibility-large": "1.94",
  "accessibility-extra-large": "2.35",
  "accessibility-extra-extra-large": "2.76",
  "accessibility-extra-extra-extra-large": "3.12",
};

interface AndroidChange {
  // The `adb shell` command string. Values here are tool-controlled constants
  // (mode strings, 0/1 flags, font-scale floats), never raw caller input, so no
  // shell-quoting is needed. Multiple `settings put` calls are chained with `&&`
  // so a failure short-circuits to a non-zero exit.
  shellCommand: string;
  // Human-readable description of the concrete platform-level change.
  applied: string;
  // Lowest API level on which the command actually changes the device. Only for
  // a command that stays silent below its floor — one that refuses out loud is
  // caught by the exit-code/stderr check instead and needs no probe.
  minSdk?: number;
  // Only for a chained `shellCommand`: what the device is left holding when a
  // write part-way down the chain fails. The caller cannot infer it from the
  // error, and the state is neither the old one nor the one it asked for.
  partialOnFailure?: string;
}

/** Android 10 — the first release where `location_mode` is the master switch. */
const LOCATION_MODE_MIN_SDK = 29;

// Translate an abstract (setting, value) into the concrete `adb` change. Central
// validation already guaranteed `value` is legal for `setting`, so every branch
// here has a well-defined mapping.
function androidChange(setting: SystemSetting, value: string): AndroidChange {
  const on = value === "on";
  switch (setting) {
    case "appearance": {
      const mode = NIGHT_MODE[value]!;
      return { shellCommand: `cmd uimode night ${mode}`, applied: `night_mode=${mode}` };
    }
    case "text-size": {
      const scale = FONT_SCALE[value as (typeof TEXT_SIZE_VALUES)[number]]!;
      return {
        shellCommand: `settings put system font_scale ${scale}`,
        applied: `font_scale=${scale}`,
      };
    }
    case "increase-contrast": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put secure high_text_contrast_enabled ${flag}`,
        applied: `high_text_contrast_enabled=${flag}`,
      };
    }
    case "reduce-motion": {
      // Android has no single "reduce motion" flag; the analogue is turning the
      // three animation scales off. `on` (reduce motion) → 0, `off` → 1.
      const scale = on ? "0" : "1";
      return {
        shellCommand:
          `settings put global window_animation_scale ${scale} && ` +
          `settings put global transition_animation_scale ${scale} && ` +
          `settings put global animator_duration_scale ${scale}`,
        applied: `animation_scales=${scale}`,
        partialOnFailure:
          `The three scales are written one after another, so some may already hold ${scale}. ` +
          `Each write sets an absolute value, so repeating this call finishes the change.`,
      };
    }
    case "invert-colors": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put secure accessibility_display_inversion_enabled ${flag}`,
        applied: `accessibility_display_inversion_enabled=${flag}`,
      };
    }
    case "wifi":
      return {
        shellCommand: `svc wifi ${on ? "enable" : "disable"}`,
        applied: `wifi=${on ? "enabled" : "disabled"}`,
      };
    case "cellular":
      return {
        shellCommand: `svc data ${on ? "enable" : "disable"}`,
        applied: `mobile_data=${on ? "enabled" : "disabled"}`,
      };
    case "airplane-mode":
      return {
        shellCommand: `cmd connectivity airplane-mode ${on ? "enable" : "disable"}`,
        applied: `airplane_mode=${on ? "enabled" : "disabled"}`,
      };
    case "location": {
      // location_mode 3 = high accuracy (on), 0 = off. The write is accepted at
      // every API level but only drives the master switch from Q on: on API 24
      // `location_mode` flips while `location_providers_allowed` stays `gps` and
      // location keeps working, so the floor is checked before running it.
      const mode = on ? "3" : "0";
      return {
        shellCommand: `settings put secure location_mode ${mode}`,
        applied: `location_mode=${mode}`,
        minSdk: LOCATION_MODE_MIN_SDK,
      };
    }
    case "auto-rotate": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put system accelerometer_rotation ${flag}`,
        applied: `accelerometer_rotation=${flag}`,
      };
    }
  }
}

// The adb client prints its own notices on stderr on a call that then
// succeeds: the daemon startup banner (`* daemon …`) after a server restart,
// and a server-version mismatch ("adb server version (…) doesn't match this
// client (…); killing…", which carries no `*`). parseAdbDevices skips the `*`
// banner lines for the same reason; only what survives these known chatter
// forms can be the device's own report.
function stripAdbBanner(stderr: string): string {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        !line.trimStart().startsWith("*") &&
        !/adb server version \(\d+\) doesn't match this client \(\d+\)/.test(line)
    )
    .join("\n")
    .trim();
}

/**
 * adb's own subprocess fields, carried onto this tool's failure.
 *
 * `runAdb` throws a `FailureError` whose signal already holds the exit code and
 * signal it read off the raw `execFile` rejection; that wrapper carries no
 * `code` of its own, so re-deriving them from it would find none and the bucket
 * would lose the exit code its iOS twin keeps.
 */
function adbSubprocessMetadata(cause: unknown): Partial<FailureSignal> {
  const { failure_command, failure_exit_code, failure_signal, failure_spawn_code } =
    getFailureSignal(cause) ?? {};
  return {
    failure_command: failure_command ?? "adb",
    ...(failure_exit_code === undefined ? {} : { failure_exit_code }),
    ...(failure_signal === undefined ? {} : { failure_signal }),
    ...(failure_spawn_code === undefined ? {} : { failure_spawn_code }),
  };
}

function withPartialState(detail: string, partialOnFailure: string | undefined): string {
  return partialOnFailure === undefined ? detail : `${detail.trim()} ${partialOnFailure}`;
}

function settingFailure(
  setting: SystemSetting,
  value: string,
  udid: string,
  detail: string,
  failureStage: string,
  cause?: unknown
): never {
  throw new FailureError(
    `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}`,
    {
      error_code: FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED,
      failure_stage: failureStage,
      failure_area: "tool_server",
      error_kind: "subprocess",
      // Only a thrown adb error carries the syscall/exit metadata; a refusal the
      // device printed while adb itself exited 0 has none to contribute.
      ...(cause ? adbSubprocessMetadata(cause) : {}),
    },
    cause instanceof Error ? { cause } : undefined
  );
}

/**
 * Refuse a change that would sever the adb transport it travels over.
 *
 * On a wirelessly-debugged device, adb rides the device's own Wi-Fi link. Both
 * `svc wifi disable` and `cmd connectivity airplane-mode enable` take that link
 * down, so the write lands and then nothing can reach the device again — not the
 * response, and not the call that would undo it. Recovery needs a USB cable or
 * physical access, so refuse up front rather than strand the session; over USB,
 * or over the loopback an emulator is reached on, both are fine.
 */
function assertKeepsTransport(udid: string, setting: SystemSetting, value: string): void {
  const dropsWifi =
    (setting === "wifi" && value === "off") || (setting === "airplane-mode" && value === "on");
  if (!dropsWifi || !isWirelessAdbSerial(udid)) return;
  throw new InvalidToolInputError(
    `Setting '${setting}' to '${value}' on ${udid} would switch off the Wi-Fi link adb reaches it over, ` +
      `leaving no way to reach the device or undo the change. Use a USB connection for this change, ` +
      `or make it on the device itself.`,
    {
      error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
      failure_stage: "android_system_setting_self_disconnect",
      error_kind: "unsupported",
    }
  );
}

/** Ceiling for the one `adb shell` that applies the setting. Summed with the
 * API-level probe that can precede it, this has to stay under the MCP client's
 * 30s per-attempt cap; above it the client aborts and replays the call while the
 * abandoned `adb` keeps running, and this tool's own diagnostic — the device's
 * verbatim refusal — never reaches the agent. */
export const ADB_SETTING_TIMEOUT_MS = 15_000;

/** The device's API level, or null when the property is missing/unparseable. */
async function sdkLevel(udid: string): Promise<number | null> {
  const raw = await adbShell(udid, "getprop ro.build.version.sdk", {
    timeoutMs: ENRICH_TIMEOUT_MS,
  });
  const level = parseInt(raw.trim(), 10);
  return Number.isFinite(level) ? level : null;
}

export const androidImpl: PlatformImpl<
  SystemSettingsServices,
  SystemSettingsParams,
  SystemSettingsResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, setting, value } = params;
    assertKeepsTransport(udid, setting, value);

    const { shellCommand, applied, minSdk, partialOnFailure } = androidChange(setting, value);

    if (minSdk !== undefined) {
      // The floor exists because the write is silently inert below it, so the
      // level has to be known: an unverifiable one fails closed, since reporting
      // `applied` for a change that may never have taken is the exact outcome the
      // floor is here to prevent (an empty `getprop` is reachable on a device
      // that is adb-visible but not finished booting). A transport failure keeps
      // adb's classification; any other probe failure is wrapped with this call's
      // own context, so it doesn't reach the agent as a bare `getprop` error.
      let level: number | null;
      try {
        level = await sdkLevel(udid);
      } catch (err) {
        if (isAdbTransportFailure(err)) throw err;
        settingFailure(
          setting,
          value,
          udid,
          err instanceof Error ? err.message : String(err),
          "android_system_setting_api_probe",
          err
        );
      }
      if (level === null || level < minSdk) {
        // Same class as the iOS "Android-only" rejection: this target cannot
        // carry the change out and no retry will change that, so it is caller
        // input (400) rather than a subprocess fault an agent would retry.
        throw new InvalidToolInputError(
          level === null
            ? `'${setting}' needs Android API ${minSdk}+, but ${udid} did not report a readable API ` +
                `level, so this can't confirm the write would take effect.`
            : `'${setting}' needs Android API ${minSdk}+; ${udid} reports API ${level}. ` +
                `The write is accepted there but leaves the device unchanged.`,
          {
            error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
            failure_stage: "android_system_setting_api_floor",
            error_kind: "unsupported",
          }
        );
      }
    }

    let stderr: string;
    try {
      // Neither channel alone is a success signal. `settings put` / `cmd` / `svc`
      // exit non-zero (→ runAdb throws) when the shell command itself refuses,
      // but a binder service that exists with no shell-command handler — what
      // `cmd uimode` / `cmd connectivity` are below their API floor — takes
      // Android's default `Binder.handleShellCommand`, which prints
      // "No shell command implementation." on stderr and returns 0. Reading only
      // the exit code answers `applied` for a change the device refused.
      ({ stderr } = await runAdb(["-s", udid, "shell", shellCommand], {
        timeoutMs: ADB_SETTING_TIMEOUT_MS,
      }));
    } catch (err) {
      if (isAdbTransportFailure(err)) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      settingFailure(
        setting,
        value,
        udid,
        withPartialState(detail, partialOnFailure),
        "android_system_setting_adb",
        err
      );
    }

    const refusal = stripAdbBanner(stderr);
    if (refusal) {
      // A binder service with no shell-command handler ("No shell command
      // implementation.") or a command that answers with its own usage text is
      // the device's Android version not implementing this — the same "try a
      // newer runtime" situation the iOS branch names. The raw text alone reads
      // like a bug in the tool, so say what it means.
      const versionHint = /no shell command implementation|usage:\s*svc\b/i.test(refusal)
        ? ` This Android version has no handler for '${setting}'; a newer system image may add it.`
        : "";
      settingFailure(
        setting,
        value,
        udid,
        withPartialState(refusal, partialOnFailure) + versionHint,
        "android_system_setting_refused"
      );
    }

    return { setting, value, applied };
  },
};

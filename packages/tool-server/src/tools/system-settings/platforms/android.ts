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

const NIGHT_MODE: Record<string, string> = { light: "no", dark: "yes" };

// Each iOS category's body-text point size relative to `large` (17pt).
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
  // Built from constants only, never caller input, so it needs no quoting.
  shellCommand: string;
  applied: string;
  // For a write the device accepts but ignores below this API level.
  minSdk?: number;
  // For a chained command: what a failure part-way leaves on the device.
  partialOnFailure?: string;
}

/** Android 10, where `location_mode` became the master switch. */
const LOCATION_MODE_MIN_SDK = 29;

const ADB_SETTING_TIMEOUT_MS = 15_000;

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
      // 3 = high accuracy.
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

// adb prints these on stderr on a call that then succeeds: the daemon startup
// banner and the server-version-mismatch notice.
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

// `runAdb` already read these off the raw `execFile` rejection; its own
// FailureError carries no `code` to re-derive them from.
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
      ...(cause ? adbSubprocessMetadata(cause) : {}),
    },
    cause instanceof Error ? { cause } : undefined
  );
}

// Over wireless adb these take down the link the call travels over, and with it
// any way to undo them.
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
      // An unreadable level fails closed: the write would be silent if inert.
      if (level === null || level < minSdk) {
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
      // `runAdb`, not `adbShell`: a binder service with no shell-command handler
      // (`cmd uimode` on old APIs) prints "No shell command implementation." on
      // stderr and exits 0.
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

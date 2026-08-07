import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    adbShell: vi.fn(async () => ""),
    shellQuote: actual.shellQuote,
  };
});

import { FAILURE_CODES, getFailureSignal, zodObjectToJsonSchema } from "@argent/registry";
import { systemSettingsTool } from "../src/tools/system-settings";
import { iosImpl } from "../src/tools/system-settings/platforms/ios";
import { androidImpl } from "../src/tools/system-settings/platforms/android";
import { SYSTEM_SETTINGS, TEXT_SIZE_VALUES } from "../src/tools/system-settings/types";
import type { SystemSettingsParams } from "../src/tools/system-settings/types";
import { adbShell } from "../src/utils/adb";
import { InvalidToolInputError } from "../src/utils/capability";

const mockAdbShell = vi.mocked(adbShell);

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";
const IOS_DEVICE = { id: IOS_UDID, platform: "ios", kind: "simulator" } as const;

// FailureError attaches its FailureSignal under a non-enumerable symbol, so
// assert through the public accessor. The `typeof code === "string"` guard is
// load-bearing: if a FAILURE_CODES member ever resolves to `undefined` (e.g. a
// stale @argent/registry dist that predates a new code), the matcher would
// otherwise degrade to `undefined === undefined` and pass for any rejection.
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

// promisify(execFile) with the mocked (symbol-less) execFile falls back to
// standard callback promisification: resolve = success, cb(err) = failure.
function execFileSucceeds(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
      cb(null, { stdout: "", stderr: "" });
    }
  );
}

function execFileFails(message: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(Object.assign(new Error(message), { code: 1, stderr: message }));
    }
  );
}

// How `simctl ui` refuses an argument for `content_size` / `increase_contrast`:
// the message goes to stderr and the exit code stays 0. Verified against
// `xcrun simctl ui <udid> content_size gigantic` on iOS 18.6 (stderr "Invalid
// argument", exit 0); `appearance` is the only option that also exits non-zero.
function execFileSucceedsWithStderr(message: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
      cb(null, { stdout: "", stderr: message });
    }
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  mockAdbShell.mockReset();
  mockAdbShell.mockImplementation(async () => "");
});

describe("system-settings failure codes are defined", () => {
  // Guards the whole suite: `failsWith` compares against these constants, and a
  // stale @argent/registry dist that predates them resolves them to `undefined`,
  // silently defanging every assertion. Assert they are real strings.
  it("resolves the three system-settings codes to strings", () => {
    for (const code of [
      "SYSTEM_SETTING_UNSUPPORTED",
      "IOS_SYSTEM_SETTING_FAILED",
      "ANDROID_SYSTEM_SETTING_FAILED",
    ] as const) {
      expect(typeof FAILURE_CODES[code], code).toBe("string");
    }
  });
});

describe("system-settings schema", () => {
  const schema = systemSettingsTool.zodSchema!;

  it("accepts settings across the display, accessibility, and Android-only groups", () => {
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "dark" }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ udid: IOS_UDID, setting: "increase-contrast", value: "on" }).success
    ).toBe(true);
    expect(schema.safeParse({ udid: IOS_UDID, setting: "text-size", value: "large" }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ udid: ANDROID_SERIAL, setting: "airplane-mode", value: "on" }).success
    ).toBe(true);
  });

  it("rejects an unknown setting", () => {
    expect(schema.safeParse({ udid: IOS_UDID, setting: "brightness", value: "50" }).success).toBe(
      false
    );
  });

  it("rejects an empty udid or empty value", () => {
    expect(schema.safeParse({ udid: "", setting: "appearance", value: "dark" }).success).toBe(
      false
    );
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "" }).success).toBe(
      false
    );
  });

  it("derives a JSON schema with the full setting enum and all three fields required", () => {
    const json = zodObjectToJsonSchema(schema) as {
      required?: string[];
      properties?: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(json.required).toEqual(["udid", "setting", "value"]);
    // The enum mirrors SYSTEM_SETTINGS exactly (order and membership), so a
    // dropped/renamed setting is caught here rather than at runtime.
    expect(json.properties?.setting?.enum).toEqual([...SYSTEM_SETTINGS]);
    // `value` is validated per-setting in the handler, not the schema, so it is a
    // plain string here — pin that so a later refactor doesn't over-constrain it.
    expect(json.properties?.value?.type).toBe("string");
  });
});

describe("system-settings value validation (platform-agnostic, runs before dispatch)", () => {
  it("rejects a value not legal for the setting and lists the valid ones", async () => {
    const rejection = expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "appearance", value: "sepia" })
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toThrow(/Valid values: light, dark/);
    // An out-of-set value is a caller input error → InvalidToolInputError, which
    // the HTTP layer maps to 400 (not a generic 500).
    await rejection.toBeInstanceOf(InvalidToolInputError);
    // Short-circuits before any platform command runs.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockAdbShell).not.toHaveBeenCalled();
  });

  it("lists on | off for a boolean setting given a bad value", async () => {
    await expect(
      systemSettingsTool.execute!({}, { udid: ANDROID_SERIAL, setting: "wifi", value: "yes" })
    ).rejects.toThrow(/Valid values: on, off/);
  });

  it("lists the Dynamic Type categories when a text-size value is invalid", async () => {
    await expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "text-size", value: "huge" })
    ).rejects.toThrow(/accessibility-extra-extra-extra-large/);
  });
});

describe("system-settings iOS branch", () => {
  function params(overrides: Partial<SystemSettingsParams>): SystemSettingsParams {
    return { udid: IOS_UDID, setting: "appearance", value: "dark", ...overrides };
  }

  it("appearance runs `simctl ui <udid> appearance <value>`", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "appearance", value: "dark" }),
      IOS_DEVICE
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect(args).toEqual(["simctl", "ui", IOS_UDID, "appearance", "dark"]);
    expect(result).toEqual({ setting: "appearance", value: "dark", applied: "appearance=dark" });
  });

  it("increase-contrast `on` maps to simctl's `increase_contrast enabled`", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "increase-contrast", value: "on" }),
      IOS_DEVICE
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "ui",
      IOS_UDID,
      "increase_contrast",
      "enabled",
    ]);
    expect(result.applied).toBe("increase_contrast=enabled");
  });

  it("increase-contrast `off` maps to `increase_contrast disabled`", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "increase-contrast", value: "off" }),
      IOS_DEVICE
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "ui",
      IOS_UDID,
      "increase_contrast",
      "disabled",
    ]);
    expect(result.applied).toBe("increase_contrast=disabled");
  });

  it("text-size maps to simctl's `content_size` option and passes the category through", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "text-size", value: "accessibility-large" }),
      IOS_DEVICE
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "ui",
      IOS_UDID,
      "content_size",
      "accessibility-large",
    ]);
    expect(result.applied).toBe("content_size=accessibility-large");
  });

  it("reduce-motion `on` writes the accessibility default and posts its change notification", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "reduce-motion", value: "on" }),
      IOS_DEVICE
    );
    expect(execFileMock).toHaveBeenCalledTimes(2);
    // First: persist the flag in the accessibility defaults domain.
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "spawn",
      IOS_UDID,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "ReduceMotionEnabled",
      "-bool",
      "YES",
    ]);
    // Second: post the matching change notification so running apps re-read it.
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "simctl",
      "spawn",
      IOS_UDID,
      "notifyutil",
      "-p",
      "com.apple.Accessibility.ReduceMotionStatusDidChange",
    ]);
    expect(result.applied).toBe("ReduceMotionEnabled=YES");
  });

  it("invert-colors `off` writes ClassicInvertColorsEnabled NO", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "invert-colors", value: "off" }),
      IOS_DEVICE
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "spawn",
      IOS_UDID,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "ClassicInvertColorsEnabled",
      "-bool",
      "NO",
    ]);
    expect(result.applied).toBe("ClassicInvertColorsEnabled=NO");
  });

  it("a failed change-notification post does not fail the tool (the default write is the source of truth)", async () => {
    // defaults write succeeds; only the notifyutil post fails.
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
        if (args.includes("notifyutil")) {
          cb(Object.assign(new Error("notify boom"), { code: 1 }));
          return;
        }
        cb(null, { stdout: "", stderr: "" });
      }
    );
    const result = await iosImpl.handler(
      {},
      params({ setting: "reduce-motion", value: "on" }),
      IOS_DEVICE
    );
    expect(result.applied).toBe("ReduceMotionEnabled=YES");
  });

  it("rejects an Android-only setting with SYSTEM_SETTING_UNSUPPORTED and runs no command", async () => {
    execFileSucceeds();
    const rejection = expect(
      iosImpl.handler({}, params({ setting: "wifi", value: "on" }), IOS_DEVICE)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toBeInstanceOf(InvalidToolInputError);
    await rejection.toThrow(/Android-only/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a shutdown-simulator failure carries a boot-device hint + IOS_SYSTEM_SETTING_FAILED", async () => {
    execFileFails(
      "An error was encountered processing the command (domain=NSCocoaErrorDomain, code=405):\nUnable to lookup in current state: Shutdown"
    );
    const rejection = expect(iosImpl.handler({}, params({}), IOS_DEVICE)).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.toThrow(/must be booted first — use boot-device/);
  });

  it("an `unsupported` runtime failure carries a newer-runtime hint", async () => {
    execFileFails("increase_contrast: unsupported");
    await expect(
      iosImpl.handler({}, params({ setting: "increase-contrast", value: "on" }), IOS_DEVICE)
    ).rejects.toThrow(/isn't supported by this simulator's iOS runtime/);
  });

  it("a `simctl ui` option refused on stderr fails, even though simctl exits 0", async () => {
    // The whole point of reading stderr: `content_size` and `increase_contrast`
    // report a refused argument and still exit 0, so an exit-code-only check
    // answers `applied` for a setting the runtime never changed.
    execFileSucceedsWithStderr("Invalid argument");
    const rejection = expect(
      iosImpl.handler({}, params({ setting: "text-size", value: "large" }), IOS_DEVICE)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.toThrow(/isn't supported by this simulator's iOS runtime/);
  });

  it("keeps applying an option whose stderr is only whitespace", async () => {
    execFileSucceedsWithStderr("\n");
    const result = await iosImpl.handler(
      {},
      params({ setting: "appearance", value: "light" }),
      IOS_DEVICE
    );
    expect(result.applied).toBe("appearance=light");
  });

  it("the boot-device hint covers `simctl spawn`'s wording, not just `simctl ui`'s", async () => {
    // `reduce-motion` / `invert-colors` go through `simctl spawn`, which says
    // "device is not booted" where `simctl ui` says "current state: Shutdown".
    execFileFails(
      "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n" +
        "Process spawn via launchd failed because device is not booted."
    );
    const rejection = expect(
      iosImpl.handler({}, params({ setting: "reduce-motion", value: "on" }), IOS_DEVICE)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.toThrow(/must be booted first — use boot-device/);
  });

  it("other simctl failures surface as IOS_SYSTEM_SETTING_FAILED without a spurious hint", async () => {
    execFileFails("Invalid device: nope");
    const rejection = expect(iosImpl.handler({}, params({}), IOS_DEVICE)).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.not.toThrow(/must be booted first|isn't supported/);
  });
});

describe("system-settings Android branch", () => {
  const androidDevice = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" } as const;

  function params(overrides: Partial<SystemSettingsParams>): SystemSettingsParams {
    return { udid: ANDROID_SERIAL, setting: "appearance", value: "dark", ...overrides };
  }

  async function run(overrides: Partial<SystemSettingsParams>) {
    const result = await androidImpl.handler({}, params(overrides), androidDevice);
    const shellCmd = mockAdbShell.mock.calls[0]![1] as string;
    return { result, shellCmd };
  }

  it("appearance dark runs `cmd uimode night yes`", async () => {
    const { result, shellCmd } = await run({ value: "dark" });
    expect(mockAdbShell).toHaveBeenCalledTimes(1);
    expect(mockAdbShell.mock.calls[0]![0]).toBe(ANDROID_SERIAL);
    expect(shellCmd).toBe("cmd uimode night yes");
    expect(result).toEqual({ setting: "appearance", value: "dark", applied: "night_mode=yes" });
  });

  it("appearance light runs `cmd uimode night no`", async () => {
    const { shellCmd } = await run({ value: "light" });
    expect(shellCmd).toBe("cmd uimode night no");
  });

  it("increase-contrast off clears the high_text_contrast_enabled flag", async () => {
    const { result, shellCmd } = await run({ setting: "increase-contrast", value: "off" });
    expect(shellCmd).toBe("settings put secure high_text_contrast_enabled 0");
    expect(result.applied).toBe("high_text_contrast_enabled=0");
  });

  it("text-size sets a font_scale float for the mapped category", async () => {
    const { result, shellCmd } = await run({ setting: "text-size", value: "accessibility-large" });
    expect(shellCmd).toBe("settings put system font_scale 1.94");
    expect(result.applied).toBe("font_scale=1.94");
  });

  it("every text-size category maps to a defined font_scale (no `undefined` reaches adb)", async () => {
    for (const size of TEXT_SIZE_VALUES) {
      mockAdbShell.mockClear();
      const result = await androidImpl.handler(
        {},
        params({ setting: "text-size", value: size }),
        androidDevice
      );
      const shellCmd = mockAdbShell.mock.calls[0]![1] as string;
      expect(shellCmd, size).toMatch(/^settings put system font_scale \d/);
      expect(shellCmd, size).not.toContain("undefined");
      expect(result.applied, size).toMatch(/^font_scale=\d/);
    }
  });

  it("reduce-motion on drives all three animation scales to 0", async () => {
    const { result, shellCmd } = await run({ setting: "reduce-motion", value: "on" });
    expect(shellCmd).toBe(
      "settings put global window_animation_scale 0 && " +
        "settings put global transition_animation_scale 0 && " +
        "settings put global animator_duration_scale 0"
    );
    expect(result.applied).toBe("animation_scales=0");
  });

  it("reduce-motion off restores the animation scales to 1", async () => {
    const { shellCmd } = await run({ setting: "reduce-motion", value: "off" });
    expect(shellCmd).toBe(
      "settings put global window_animation_scale 1 && " +
        "settings put global transition_animation_scale 1 && " +
        "settings put global animator_duration_scale 1"
    );
  });

  it("invert-colors on sets the inversion accessibility flag", async () => {
    const { result, shellCmd } = await run({ setting: "invert-colors", value: "on" });
    expect(shellCmd).toBe("settings put secure accessibility_display_inversion_enabled 1");
    expect(result.applied).toBe("accessibility_display_inversion_enabled=1");
  });

  it("wifi maps on/off to `svc wifi enable/disable`", async () => {
    expect((await run({ setting: "wifi", value: "on" })).shellCmd).toBe("svc wifi enable");
    mockAdbShell.mockClear();
    const { result, shellCmd } = await run({ setting: "wifi", value: "off" });
    expect(shellCmd).toBe("svc wifi disable");
    expect(result.applied).toBe("wifi=disabled");
  });

  it("cellular maps to `svc data enable/disable` (mobile_data)", async () => {
    const { result, shellCmd } = await run({ setting: "cellular", value: "on" });
    expect(shellCmd).toBe("svc data enable");
    expect(result.applied).toBe("mobile_data=enabled");
  });

  it("airplane-mode maps to `cmd connectivity airplane-mode enable/disable`", async () => {
    const { result, shellCmd } = await run({ setting: "airplane-mode", value: "on" });
    expect(shellCmd).toBe("cmd connectivity airplane-mode enable");
    expect(result.applied).toBe("airplane_mode=enabled");
  });

  it("location on sets location_mode 3 (high accuracy), off sets 0", async () => {
    expect((await run({ setting: "location", value: "on" })).shellCmd).toBe(
      "settings put secure location_mode 3"
    );
    mockAdbShell.mockClear();
    const { result, shellCmd } = await run({ setting: "location", value: "off" });
    expect(shellCmd).toBe("settings put secure location_mode 0");
    expect(result.applied).toBe("location_mode=0");
  });

  it("auto-rotate maps on/off to accelerometer_rotation 1/0", async () => {
    const { result, shellCmd } = await run({ setting: "auto-rotate", value: "on" });
    expect(shellCmd).toBe("settings put system accelerometer_rotation 1");
    expect(result.applied).toBe("accelerometer_rotation=1");
  });

  it("an adb failure surfaces as ANDROID_SYSTEM_SETTING_FAILED", async () => {
    mockAdbShell.mockRejectedValueOnce(new Error("error: device offline"));
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED)
    );
  });
});

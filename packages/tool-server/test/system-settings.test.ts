import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    adbShell: vi.fn(async () => ""),
    runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  };
});

vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, getSimulatorRuntimeKind: vi.fn(async () => "mobile" as const) };
});

// Keeps argv assertions independent of the host's `ios.additionalDeviceSets`.
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  getAdditionalIosDeviceSets: () => [],
}));

import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  zodObjectToJsonSchema,
} from "@argent/registry";
import { systemSettingsTool } from "../src/tools/system-settings";
import { iosImpl } from "../src/tools/system-settings/platforms/ios";
import { androidImpl } from "../src/tools/system-settings/platforms/android";
import {
  IOS_SUPPORTED_SETTINGS,
  SETTING_VALUES,
  SYSTEM_SETTINGS,
} from "../src/tools/system-settings/types";
import type { SystemSetting } from "../src/tools/system-settings/types";
import { adbShell, runAdb, ENRICH_TIMEOUT_MS } from "../src/utils/adb";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../src/utils/simctl-config";
import { getSimulatorRuntimeKind } from "../src/utils/ios-devices";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { rememberDeviceSet, __resetDeviceSetCacheForTesting } from "../src/utils/ios-device-sets";

const mockAdbShell = vi.mocked(adbShell);
const mockRunAdb = vi.mocked(runAdb);
const mockRuntimeKind = vi.mocked(getSimulatorRuntimeKind);

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";
const IOS_DEVICE = { id: IOS_UDID, platform: "ios", kind: "simulator" } as const;

function execFileResolves(stderr = ""): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) =>
      cb(null, { stdout: "", stderr })
  );
}

function execFileRejects(err: Error): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(err)
  );
}

function execFileFails(message: string): void {
  execFileRejects(Object.assign(new Error(message), { code: 1, stderr: message }));
}

function ios(setting: SystemSetting, value: string) {
  return iosImpl.handler({}, { udid: IOS_UDID, setting, value }, IOS_DEVICE);
}

function android(setting: SystemSetting, value: string, udid = ANDROID_SERIAL) {
  return androidImpl.handler({}, { udid, setting, value }, {
    id: udid,
    platform: "android",
    kind: "device",
  } as const);
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  if (!(err instanceof Error)) throw new Error("expected a rejection");
  return err;
}

beforeEach(() => {
  execFileMock.mockReset();
  mockAdbShell.mockReset();
  mockAdbShell.mockImplementation(async () => "");
  mockRunAdb.mockReset();
  mockRunAdb.mockImplementation(async () => ({ stdout: "", stderr: "" }));
  mockRuntimeKind.mockReset();
  mockRuntimeKind.mockImplementation(async () => "mobile");
});

describe("system-settings definition", () => {
  it("supports Apple simulators and every Android target, with no remote simulator", () => {
    expect(systemSettingsTool.capability).toEqual({
      apple: { simulator: true },
      android: { emulator: true, device: true, unknown: true },
    });
    expect(iosImpl.requires).toEqual(["xcrun"]);
    expect(androidImpl.requires).toEqual(["adb"]);
  });

  it("advertises every setting and value, with all three fields required", () => {
    const json = zodObjectToJsonSchema(systemSettingsTool.zodSchema!) as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(json.required).toEqual(["udid", "setting", "value"]);
    expect(json.properties?.setting?.enum).toEqual([
      "appearance",
      "text-size",
      "increase-contrast",
      "reduce-motion",
      "invert-colors",
      "wifi",
      "cellular",
      "airplane-mode",
      "location",
      "auto-rotate",
    ]);
    const textSizes = [
      "extra-small",
      "small",
      "medium",
      "large",
      "extra-large",
      "extra-extra-large",
      "extra-extra-extra-large",
      "accessibility-medium",
      "accessibility-large",
      "accessibility-extra-large",
      "accessibility-extra-extra-large",
      "accessibility-extra-extra-extra-large",
    ];
    expect(json.properties?.value?.enum).toEqual(["light", "dark", "on", "off", ...textSizes]);
    const onOff = ["on", "off"];
    expect(SETTING_VALUES).toEqual({
      "appearance": ["light", "dark"],
      "text-size": textSizes,
      "increase-contrast": onOff,
      "reduce-motion": onOff,
      "invert-colors": onOff,
      "wifi": onOff,
      "cellular": onOff,
      "airplane-mode": onOff,
      "location": onOff,
      "auto-rotate": onOff,
    });
  });

  it("rejects a value outside the chosen setting's set before running anything", async () => {
    const err = await failureOf(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "appearance", value: "on" })
    );
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(err.message).toContain("Valid values: light, dark.");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockRunAdb).not.toHaveBeenCalled();
  });
});

describe("system-settings on an iOS simulator", () => {
  it.each<[SystemSetting, string, string[], string]>([
    ["appearance", "dark", ["ui", IOS_UDID, "appearance", "dark"], "appearance=dark"],
    [
      "text-size",
      "accessibility-large",
      ["ui", IOS_UDID, "content_size", "accessibility-large"],
      "content_size=accessibility-large",
    ],
    [
      "increase-contrast",
      "on",
      ["ui", IOS_UDID, "increase_contrast", "enabled"],
      "increase_contrast=enabled",
    ],
    [
      "increase-contrast",
      "off",
      ["ui", IOS_UDID, "increase_contrast", "disabled"],
      "increase_contrast=disabled",
    ],
    ...(
      [
        ["reduce-motion", "on", "ReduceMotionEnabled", "YES"],
        ["reduce-motion", "off", "ReduceMotionEnabled", "NO"],
        ["invert-colors", "on", "InvertColorsEnabled", "YES"],
        ["invert-colors", "off", "InvertColorsEnabled", "NO"],
      ] as const
    ).map(([setting, value, key, bool]): [SystemSetting, string, string[], string] => [
      setting,
      value,
      ["spawn", IOS_UDID, "defaults", "write", "com.apple.Accessibility", key, "-bool", bool],
      `${key}=${bool}`,
    ]),
  ])("%s %s runs simctl %j", async (setting, value, simctlArgs, applied) => {
    execFileResolves();
    const result = await ios(setting, value);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect(args).toEqual(["simctl", ...simctlArgs]);
    expect(opts).toMatchObject({ timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
    expect(result).toEqual({ setting, value, applied });
  });

  it("passes --set for a simulator in an additional device set", async () => {
    const udid = "11111111-2222-3333-4444-555555555555";
    rememberDeviceSet(udid, "/tmp/radon/Devices");
    try {
      execFileResolves();
      const device = { id: udid, platform: "ios", kind: "simulator" } as const;
      await iosImpl.handler({}, { udid, setting: "appearance", value: "dark" }, device);
      await iosImpl.handler({}, { udid, setting: "reduce-motion", value: "on" }, device);
      expect(execFileMock.mock.calls.map((c) => (c[1] as string[]).slice(0, 4))).toEqual([
        ["simctl", "--set", "/tmp/radon/Devices", "ui"],
        ["simctl", "--set", "/tmp/radon/Devices", "spawn"],
      ]);
    } finally {
      __resetDeviceSetCacheForTesting();
    }
  });

  it.each(SYSTEM_SETTINGS.filter((s) => !IOS_SUPPORTED_SETTINGS.includes(s)))(
    "rejects Android-only %s without probing the runtime",
    async (setting) => {
      const err = await failureOf(ios(setting, "on"));
      expect(err).toBeInstanceOf(InvalidToolInputError);
      expect(getFailureSignal(err)?.failure_stage).toBe("ios_system_setting_unsupported");
      expect(err.message).toContain(`iOS-supported settings: ${IOS_SUPPORTED_SETTINGS.join(", ")}`);
      expect(mockRuntimeKind).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["tv", /tvOS/],
    [undefined, /does not report .* as an available iOS simulator/],
  ] as const)("rejects a simulator whose runtime is %s", async (kind, message) => {
    mockRuntimeKind.mockResolvedValueOnce(kind);
    execFileResolves();
    const err = await failureOf(ios("reduce-motion", "on"));
    expect(err).toBeInstanceOf(UnsupportedOperationError);
    expect(err.message).toMatch(message);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("fails a `simctl ui` refusal printed on stderr with exit 0", async () => {
    execFileResolves("Invalid argument");
    const err = await failureOf(ios("text-size", "large"));
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED,
      failure_stage: "ios_system_setting_refused",
    });
    expect(err.message).not.toContain("newer runtime");
  });

  it("applies when stderr is only whitespace", async () => {
    execFileResolves("\n");
    await expect(ios("appearance", "light")).resolves.toMatchObject({
      applied: "appearance=light",
    });
  });

  it.each([
    ["appearance", "Unable to lookup in current state: Shutdown", "use boot-device"],
    [
      "reduce-motion",
      "Process spawn via launchd failed because device is not booted.",
      "use boot-device",
    ],
    ["appearance", "Unable to lookup in current state: Booting", "still booting"],
    ["appearance", "Operation not supported", "try a newer runtime"],
    ["appearance", "Operation not supported while the device is not booted.", "use boot-device"],
  ] as const)("%s failing with %j hints %j", async (setting, stderr, hint) => {
    execFileFails(stderr);
    const err = await failureOf(ios(setting, setting === "appearance" ? "dark" : "on"));
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED,
      failure_stage: "ios_system_setting_apply",
      error_kind: "subprocess",
      failure_command: "xcrun_simctl",
    });
    expect(err.message).toContain(hint);
    const otherHints = ["use boot-device", "still booting", "try a newer runtime"].filter(
      (h) => h !== hint
    );
    for (const other of otherHints) expect(err.message).not.toContain(other);
  });

  it("keeps the newer-runtime hint off a `defaults` write", async () => {
    execFileFails("defaults: operation not supported");
    const err = await failureOf(ios("reduce-motion", "on"));
    expect(err.message).not.toContain("newer runtime");
  });

  it("reports a simctl killed by its timeout as a timeout", async () => {
    execFileRejects(
      Object.assign(new Error("Command failed: xcrun simctl ui"), {
        killed: true,
        signal: "SIGKILL",
      })
    );
    const err = await failureOf(ios("appearance", "dark"));
    expect(getFailureSignal(err)?.error_kind).toBe("timeout");
    expect(err.message).toContain("killed after its timeout");
  });
});

describe("system-settings on Android", () => {
  it.each<[SystemSetting, string, string, string]>([
    ["appearance", "dark", "cmd uimode night yes", "night_mode=yes"],
    ["appearance", "light", "cmd uimode night no", "night_mode=no"],
    [
      "increase-contrast",
      "on",
      "settings put secure high_text_contrast_enabled 1",
      "high_text_contrast_enabled=1",
    ],
    [
      "increase-contrast",
      "off",
      "settings put secure high_text_contrast_enabled 0",
      "high_text_contrast_enabled=0",
    ],
    [
      "reduce-motion",
      "on",
      "settings put global window_animation_scale 0 && settings put global transition_animation_scale 0 && settings put global animator_duration_scale 0",
      "animation_scales=0",
    ],
    [
      "reduce-motion",
      "off",
      "settings put global window_animation_scale 1 && settings put global transition_animation_scale 1 && settings put global animator_duration_scale 1",
      "animation_scales=1",
    ],
    [
      "invert-colors",
      "on",
      "settings put secure accessibility_display_inversion_enabled 1",
      "accessibility_display_inversion_enabled=1",
    ],
    [
      "invert-colors",
      "off",
      "settings put secure accessibility_display_inversion_enabled 0",
      "accessibility_display_inversion_enabled=0",
    ],
    ["wifi", "on", "svc wifi enable", "wifi=enabled"],
    ["wifi", "off", "svc wifi disable", "wifi=disabled"],
    ["cellular", "on", "svc data enable", "mobile_data=enabled"],
    ["cellular", "off", "svc data disable", "mobile_data=disabled"],
    ["airplane-mode", "on", "cmd connectivity airplane-mode enable", "airplane_mode=enabled"],
    ["airplane-mode", "off", "cmd connectivity airplane-mode disable", "airplane_mode=disabled"],
    ["location", "on", "settings put secure location_mode 3", "location_mode=3"],
    ["location", "off", "settings put secure location_mode 0", "location_mode=0"],
    [
      "auto-rotate",
      "on",
      "settings put system accelerometer_rotation 1",
      "accelerometer_rotation=1",
    ],
    [
      "auto-rotate",
      "off",
      "settings put system accelerometer_rotation 0",
      "accelerometer_rotation=0",
    ],
    ...(
      [
        ["extra-small", "0.82"],
        ["small", "0.88"],
        ["medium", "0.94"],
        ["large", "1.0"],
        ["extra-large", "1.12"],
        ["extra-extra-large", "1.24"],
        ["extra-extra-extra-large", "1.35"],
        ["accessibility-medium", "1.65"],
        ["accessibility-large", "1.94"],
        ["accessibility-extra-large", "2.35"],
        ["accessibility-extra-extra-large", "2.76"],
        ["accessibility-extra-extra-extra-large", "3.12"],
      ] as const
    ).map(([size, scale]): [SystemSetting, string, string, string] => [
      "text-size",
      size,
      `settings put system font_scale ${scale}`,
      `font_scale=${scale}`,
    ]),
  ])("%s %s runs `%s`", async (setting, value, command, applied) => {
    mockAdbShell.mockResolvedValue("34");
    const result = await android(setting, value);
    expect(mockRunAdb).toHaveBeenCalledTimes(1);
    expect(mockRunAdb).toHaveBeenCalledWith(["-s", ANDROID_SERIAL, "shell", command], {
      timeoutMs: 15_000,
    });
    expect(result).toEqual({ setting, value, applied });
    // Only `location` reads the API level.
    expect(mockAdbShell.mock.calls).toEqual(
      setting === "location"
        ? [[ANDROID_SERIAL, "getprop ro.build.version.sdk", { timeoutMs: ENRICH_TIMEOUT_MS }]]
        : []
    );
  });

  it.each(SYSTEM_SETTINGS)(
    "fails %s when the device refuses on stderr with exit 0",
    async (setting) => {
      mockAdbShell.mockResolvedValue("34");
      mockRunAdb.mockResolvedValue({ stdout: "", stderr: "No shell command implementation." });
      const err = await failureOf(android(setting, SETTING_VALUES[setting][0]!));
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED,
        failure_stage: "android_system_setting_refused",
      });
      expect(err.message).toContain(`This Android version has no handler for '${setting}'`);
    }
  );

  it("records no subprocess exit data for a stderr refusal", async () => {
    mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr: "Wi-Fi: connection reset by peer" });
    const signal = getFailureSignal(await failureOf(android("wifi", "on")));
    expect(signal?.error_code).toBe(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED);
    expect(signal?.failure_exit_code).toBeUndefined();
    expect(signal?.failure_signal).toBeUndefined();
  });

  it.each([
    "\n",
    "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n",
    "  * daemon started successfully",
    "adb server version (41) doesn't match this client (39); killing...\n",
  ])("ignores adb's own stderr chatter %j", async (stderr) => {
    mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr });
    await expect(android("wifi", "on")).resolves.toMatchObject({ applied: "wifi=enabled" });
  });

  it("fails a refusal that follows adb's banner", async () => {
    mockRunAdb.mockResolvedValueOnce({
      stdout: "",
      stderr: "* daemon started successfully\nusage: svc wifi [enable|disable]\n",
    });
    const err = await failureOf(android("wifi", "on"));
    expect(err.message).toContain("usage: svc wifi");
    expect(err.message).toContain("This Android version has no handler");
  });

  it("carries runAdb's subprocess data onto a command failure", async () => {
    mockRunAdb.mockRejectedValueOnce(
      new FailureError("adb -s emulator-5554 shell svc wifi enable failed: boom", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
        failure_exit_code: 7,
        failure_signal: "SIGKILL",
        failure_spawn_code: "ENOENT",
      })
    );
    const err = await failureOf(android("wifi", "on"));
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED,
      failure_stage: "android_system_setting_adb",
      error_kind: "subprocess",
      failure_command: "adb",
      failure_exit_code: 7,
      failure_signal: "SIGKILL",
      failure_spawn_code: "ENOENT",
    });
    expect(err.message).toContain(ANDROID_SERIAL);
  });

  it("names adb when the failure carries no signal", async () => {
    mockRunAdb.mockRejectedValueOnce(new Error("boom"));
    const err = await failureOf(android("wifi", "on"));
    expect(getFailureSignal(err)?.failure_command).toBe("adb");
  });

  it.each([
    new Error("error: device 'emulator-5554' offline"),
    new Error("protocol fault (couldn't read status): Connection reset by peer"),
    new FailureError("adb timed out", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "timeout",
    }),
  ])("propagates the transport failure %s unchanged", async (transport) => {
    mockRunAdb.mockRejectedValueOnce(transport);
    await expect(android("wifi", "on")).rejects.toBe(transport);
  });

  describe("a failure part-way through reduce-motion's chained writes", () => {
    it.each([
      ["a thrown error", () => mockRunAdb.mockRejectedValueOnce(new Error("killed"))],
      [
        "a stderr refusal",
        () => mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr: "permission denied" }),
      ],
    ])("says what the device may hold after %s", async (_, arrange) => {
      arrange();
      const err = await failureOf(android("reduce-motion", "on"));
      expect(err.message).toContain("some may already hold 0");
      expect(err.message).toContain("repeating this call finishes the change");
    });

    it("is not said for a single write", async () => {
      mockRunAdb.mockRejectedValueOnce(new Error("killed"));
      const err = await failureOf(android("increase-contrast", "on"));
      expect(err.message).not.toContain("may already hold");
    });
  });

  describe("location's API floor", () => {
    it.each([
      ["24", "needs Android API 29+; emulator-5554 reports API 24"],
      ["", "did not report a readable API level"],
    ])("refuses at API %j", async (level, message) => {
      mockAdbShell.mockResolvedValueOnce(level);
      const err = await failureOf(android("location", "off"));
      expect(err).toBeInstanceOf(InvalidToolInputError);
      expect(err.message).toContain(message);
      expect(getFailureSignal(err)?.failure_stage).toBe("android_system_setting_api_floor");
      expect(mockRunAdb).not.toHaveBeenCalled();
    });

    it("applies at API 29", async () => {
      mockAdbShell.mockResolvedValueOnce("29");
      await expect(android("location", "on")).resolves.toMatchObject({
        applied: "location_mode=3",
      });
    });

    it("propagates a transport failure from the probe unchanged", async () => {
      const transport = new Error("error: device 'emulator-5554' offline");
      mockAdbShell.mockRejectedValueOnce(transport);
      await expect(android("location", "on")).rejects.toBe(transport);
    });

    it("wraps a probe failure with the call's context", async () => {
      mockAdbShell.mockRejectedValueOnce(new Error("getprop failed: boom"));
      const err = await failureOf(android("location", "on"));
      expect(err.message).toContain("Failed to set 'location' to 'on' on emulator-5554");
      expect(getFailureSignal(err)?.failure_stage).toBe("android_system_setting_api_probe");
      expect(mockRunAdb).not.toHaveBeenCalled();
    });
  });

  describe("a change that would cut wireless adb", () => {
    const LAN = "192.168.1.42:5555";
    const MDNS = "adb-39121FDJG0026R-tGGCXo._adb-tls-connect._tcp";

    it.each([
      [LAN, "wifi", "off"],
      [LAN, "airplane-mode", "on"],
      [MDNS, "wifi", "off"],
      [MDNS, "airplane-mode", "on"],
    ] as const)("refuses %s %s=%s", async (udid, setting, value) => {
      const err = await failureOf(android(setting, value, udid));
      expect(err).toBeInstanceOf(InvalidToolInputError);
      expect(err.message).toContain(udid);
      expect(err.message).toContain("Use a USB connection");
      expect(getFailureSignal(err)?.failure_stage).toBe("android_system_setting_self_disconnect");
      expect(mockRunAdb).not.toHaveBeenCalled();
    });

    it.each([
      [LAN, "wifi", "on"],
      [LAN, "airplane-mode", "off"],
      [LAN, "cellular", "off"],
      [ANDROID_SERIAL, "wifi", "off"],
      ["R58M1234ABC", "airplane-mode", "on"],
      ["127.0.0.1:5555", "wifi", "off"],
    ] as const)("applies %s %s=%s", async (udid, setting, value) => {
      await expect(android(setting, value, udid)).resolves.toMatchObject({ setting, value });
      expect(mockRunAdb).toHaveBeenCalledTimes(1);
    });
  });
});

describe("system-settings dispatch", () => {
  beforeEach(() => __primeDepCacheForTests(["xcrun", "adb"]));
  afterEach(() => __resetDepCacheForTests());

  it("sends an iOS udid to simctl", async () => {
    execFileResolves();
    await expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "appearance", value: "dark" })
    ).resolves.toMatchObject({ applied: "appearance=dark" });
    expect(execFileMock.mock.calls[0]![0]).toBe("xcrun");
    expect(mockRunAdb).not.toHaveBeenCalled();
  });

  it("sends an Android serial to adb", async () => {
    await expect(
      systemSettingsTool.execute!(
        {},
        { udid: ANDROID_SERIAL, setting: "appearance", value: "light" }
      )
    ).resolves.toMatchObject({ applied: "night_mode=no" });
    expect(mockRunAdb).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

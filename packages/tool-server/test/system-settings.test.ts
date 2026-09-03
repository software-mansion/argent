import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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

// `resolveDevice` classifies an Apple TV simulator as an iOS simulator (both are
// bare UUIDs), so the iOS handler probes the runtime kind. Stub it false by
// default and flip it per-test — the real probe would shell out to `simctl list`.
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

// Device-set resolution reads `ios.additionalDeviceSets` off disk; pin it so
// the argv/call-count assertions hold on machines with extra sets configured
// (e.g. Radon IDE), where each unprimed UDID would otherwise probe every set.
// The additional-device-set describe below still exercises the real routing
// through rememberDeviceSet.
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
  SETTING_VALUE_VOCABULARY,
  SETTING_VALUES,
  SYSTEM_SETTINGS,
  TEXT_SIZE_VALUES,
} from "../src/tools/system-settings/types";
import type { SystemSettingsParams } from "../src/tools/system-settings/types";
import { adbShell, runAdb, ENRICH_TIMEOUT_MS } from "../src/utils/adb";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../src/utils/simctl-config";
import { ADB_SETTING_TIMEOUT_MS } from "../src/tools/system-settings/platforms/android";
import { SIMCTL_UI_TIMEOUT_MS } from "../src/tools/system-settings/platforms/ios";
import { isTvOsSimulator, SIMCTL_LIST_TIMEOUT_MS } from "../src/utils/ios-devices";
import { PATH_LOOKUP_TIMEOUT_MS } from "../src/utils/command-on-path";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { rememberDeviceSet, __resetDeviceSetCacheForTesting } from "../src/utils/ios-device-sets";

const mockAdbShell = vi.mocked(adbShell);
const mockRunAdb = vi.mocked(runAdb);
const mockIsTvOs = vi.mocked(isTvOsSimulator);

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
  mockRunAdb.mockReset();
  mockRunAdb.mockImplementation(async () => ({ stdout: "", stderr: "" }));
  mockIsTvOs.mockReset();
  mockIsTvOs.mockImplementation(async () => false);
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

describe("system-settings capability and mechanism coverage are pinned", () => {
  // The capability object is load-bearing prose: `apple` is simulator-only
  // because physical iPhones have no host-side equivalent, `android` covers
  // emulator/device/unknown because `adb shell cmd uimode` / `settings put`
  // work on both, and there is deliberately no `appleRemote` (sim-remote does
  // not forward `simctl ui`, so claiming the block would accept `appearance`
  // on a remote sim and fail inside the handler). None of that is enforced by
  // types — assert the exact shape so a dropped flag or an added remote claim
  // cannot ship silently.
  it("declares exactly apple-simulator and android-everywhere support", () => {
    expect(systemSettingsTool.capability).toEqual({
      apple: { simulator: true },
      android: { emulator: true, device: true, unknown: true },
    });
    expect(systemSettingsTool.capability).not.toHaveProperty("appleRemote");
  });

  // Every setting advertised as iOS-supported must have an `iosMechanism`
  // case. The guard in iosImpl checks membership in IOS_SUPPORTED_SETTINGS
  // while the mechanism switch is coupled to it only by hand: a member added
  // without a case compiles fine, passes every per-setting test, and only
  // explodes at runtime with an unclassified `No iOS mechanism for setting`.
  it("resolves every iOS-supported setting through its real handler", async () => {
    for (const setting of IOS_SUPPORTED_SETTINGS) {
      execFileSucceeds();
      const result = await iosImpl.handler(
        {},
        { udid: IOS_UDID, setting, value: SETTING_VALUES[setting][0] },
        IOS_DEVICE
      );
      expect(result.setting, setting).toBe(setting);
      expect(result.applied, setting).not.toContain("undefined");
    }
    // And the list itself stays inside the tool's vocabulary.
    for (const setting of IOS_SUPPORTED_SETTINGS) {
      expect(SYSTEM_SETTINGS, setting).toContain(setting);
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

  it("rejects an empty udid, and any value outside the whole vocabulary", () => {
    expect(schema.safeParse({ udid: "", setting: "appearance", value: "dark" }).success).toBe(
      false
    );
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "" }).success).toBe(
      false
    );
    // The schema knows the union, not the per-setting split: an oversized or
    // free-form string dies here, a legal-but-wrong-setting one survives to
    // `assertValidValue`.
    expect(
      schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "d".repeat(65) }).success
    ).toBe(false);
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "on" }).success).toBe(
      true
    );
  });

  it("derives a JSON schema advertising both vocabularies, with all three fields required", () => {
    const json = zodObjectToJsonSchema(schema) as {
      required?: string[];
      properties?: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(json.required).toEqual(["udid", "setting", "value"]);
    // Compared against literals, not against the source constants: deriving the
    // expectation from SYSTEM_SETTINGS would make the assertion tautological and
    // let a rename of a member — a change to the tool's public vocabulary —
    // through unnoticed.
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
    expect(json.properties?.value?.enum).toEqual([
      "light",
      "dark",
      "on",
      "off",
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
    ]);
  });

  it("advertises every value any setting accepts and nothing else", () => {
    // The union has to stay a superset of every per-setting set, or a legal call
    // is rejected by the schema before `assertValidValue` can narrow it.
    for (const setting of SYSTEM_SETTINGS) {
      for (const value of SETTING_VALUES[setting]) {
        expect(SETTING_VALUE_VOCABULARY, `${setting}=${value}`).toContain(value);
      }
    }
    const fromSettings = new Set(SYSTEM_SETTINGS.flatMap((s) => [...SETTING_VALUES[s]]));
    expect([...SETTING_VALUE_VOCABULARY].sort()).toEqual([...fromSettings].sort());
  });
});

describe("system-settings value validation (platform-agnostic, runs before dispatch)", () => {
  it("rejects a value not legal for the setting and lists the valid ones", async () => {
    const rejection = expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "appearance", value: "on" })
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toSatisfy((err) => getFailureSignal(err)?.error_kind === "unsupported");
    await rejection.toThrow(/Valid values: light, dark/);
    // An out-of-set value is a caller input error → InvalidToolInputError, which
    // the HTTP layer maps to 400 (not a generic 500).
    await rejection.toBeInstanceOf(InvalidToolInputError);
    // Short-circuits before any platform command runs.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockAdbShell).not.toHaveBeenCalled();
    expect(mockRunAdb).not.toHaveBeenCalled();
  });

  it("lists on | off for a boolean setting given a bad value", async () => {
    await expect(
      systemSettingsTool.execute!({}, { udid: ANDROID_SERIAL, setting: "wifi", value: "light" })
    ).rejects.toThrow(/Valid values: on, off/);
  });

  it("lists the Dynamic Type categories when a text-size value is invalid", async () => {
    await expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "text-size", value: "on" })
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

  // The two `defaults`-backed settings must write the keys the runtime reads.
  // `strings` over libAccessibility.dylib on iOS 18.6 exports `ReduceMotionEnabled`
  // and `InvertColorsEnabled`; the `ClassicInvertColorsEnabled` key that predates
  // Smart Invert appears nowhere, and writing it leaves the screen untouched
  // while the tool answers `applied`.
  it.each([
    ["reduce-motion", "on", "ReduceMotionEnabled", "YES"],
    ["reduce-motion", "off", "ReduceMotionEnabled", "NO"],
    ["invert-colors", "on", "InvertColorsEnabled", "YES"],
    ["invert-colors", "off", "InvertColorsEnabled", "NO"],
  ] as const)("%s %s writes %s -bool %s", async (setting, value, key, boolArg) => {
    execFileSucceeds();
    const result = await iosImpl.handler({}, params({ setting, value }), IOS_DEVICE);
    // One command, not two: the runtime posts the `com.apple.accessibility.*`
    // status and cache notifications itself when the preference lands (observed
    // with `notifyutil -w` on iOS 18.6 while only writing the default), so there
    // is nothing for the tool to post.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "spawn",
      IOS_UDID,
      "defaults",
      "write",
      "com.apple.Accessibility",
      key,
      "-bool",
      boolArg,
    ]);
    expect(result.applied).toBe(`${key}=${boolArg}`);
  });

  it("never posts a change notification", async () => {
    execFileSucceeds();
    for (const setting of ["reduce-motion", "invert-colors"] as const) {
      execFileMock.mockClear();
      await iosImpl.handler({}, params({ setting, value: "on" }), IOS_DEVICE);
      for (const call of execFileMock.mock.calls) {
        expect(call[1] as string[], setting).not.toContain("notifyutil");
      }
    }
  });

  it("caps and hard-kills every simctl call it makes", async () => {
    // `execFile`'s bare `timeout` sends SIGTERM once and never escalates, so a
    // simctl wedged on CoreSimulatorService ignores it and the promise never
    // settles — see SIMCTL_KILL_SIGNAL. Both mechanisms must pass the signal.
    execFileSucceeds();
    for (const setting of ["appearance", "reduce-motion"] as const) {
      execFileMock.mockClear();
      await iosImpl.handler(
        {},
        params({ setting, value: setting === "appearance" ? "dark" : "on" }),
        IOS_DEVICE
      );
      for (const call of execFileMock.mock.calls) {
        const opts = call[2] as { timeout?: number; killSignal?: string };
        expect(opts.killSignal, setting).toBe("SIGKILL");
        expect(opts.timeout, setting).toBeGreaterThan(0);
      }
    }
  });

  it("rejects an Apple TV simulator before running any command", async () => {
    // An Apple TV sim is an 8-4-4-4-12 UUID like an iPhone's, so `resolveDevice`
    // routes it here. tvOS refuses every `simctl ui` option ("Operation not
    // supported") but accepts the `defaults` writes, which would report
    // `applied` for a setting tvOS has no pane for.
    mockIsTvOs.mockResolvedValueOnce(true);
    execFileSucceeds();
    await expect(
      iosImpl.handler({}, params({ setting: "reduce-motion", value: "on" }), IOS_DEVICE)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // Every one of them, not a representative: a setting that slipped out of
  // IOS_SUPPORTED_SETTINGS' complement would reach `iosMechanism` and die on its
  // unreachable default instead of returning the 400 the agent can act on.
  it.each(SYSTEM_SETTINGS.filter((s) => !IOS_SUPPORTED_SETTINGS.includes(s)))(
    "rejects Android-only '%s' with SYSTEM_SETTING_UNSUPPORTED and runs no command",
    async (setting) => {
      execFileSucceeds();
      const rejection = expect(
        iosImpl.handler({}, params({ setting, value: SETTING_VALUES[setting][0] }), IOS_DEVICE)
      ).rejects;
      await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
      await rejection.toSatisfy((err) => getFailureSignal(err)?.error_kind === "unsupported");
      await rejection.toBeInstanceOf(InvalidToolInputError);
      await rejection.toThrow(/Android-only/);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );

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

  it("simctl's own `Operation not supported` wording earns the same hint", async () => {
    // What `simctl ui <udid> appearance dark` answers on a runtime that models
    // no appearance style (exit 45, verified on tvOS 18.5). "not supported" does
    // not contain "unsupported", so it needs its own alternative in the match.
    execFileFails(
      "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=45):\n" +
        "Simulator device failed to complete the requested operation.\nOperation not supported"
    );
    await expect(iosImpl.handler({}, params({}), IOS_DEVICE)).rejects.toThrow(
      /isn't supported by this simulator's iOS runtime/
    );
  });

  it("a `simctl ui` option refused on stderr fails, even though simctl exits 0", async () => {
    // The whole point of reading stderr: this is simctl's one refusal that
    // leaves the exit code at 0, so an exit-code-only check answers `applied`
    // for a setting the simulator never changed.
    execFileSucceedsWithStderr("Invalid argument");
    const rejection = expect(
      iosImpl.handler({}, params({ setting: "text-size", value: "large" }), IOS_DEVICE)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    // "Invalid argument" is simctl rejecting the argument, not the runtime
    // lacking the option — a newer runtime would not fix it, so the hint that
    // says so must stay off this one.
    await rejection.not.toThrow(/try a newer runtime/);
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

  // Every argv above omits `--set` because the UDID resolves to the default
  // device set. A simulator in an additional set (`ios.additionalDeviceSets`,
  // e.g. Radon IDE) is only addressable with the flag — without it simctl
  // searches the default set and answers `Invalid device: <udid>`. Both
  // mechanisms must route through `simctlArgsForUdid`, so pin both calls.
  describe("a simulator in an additional device set", () => {
    const RADON_UDID = "11111111-2222-3333-4444-555555555555";
    const RADON_SET = "/tmp/radon-ide/Devices/iOS";
    const radonDevice = { id: RADON_UDID, platform: "ios", kind: "simulator" } as const;

    beforeEach(() => rememberDeviceSet(RADON_UDID, RADON_SET));
    afterEach(() => __resetDeviceSetCacheForTesting());

    it("prefixes `simctl ui` with --set", async () => {
      execFileSucceeds();
      await iosImpl.handler(
        {},
        { udid: RADON_UDID, setting: "appearance", value: "dark" },
        radonDevice
      );
      expect(execFileMock.mock.calls[0]![1]).toEqual([
        "simctl",
        "--set",
        RADON_SET,
        "ui",
        RADON_UDID,
        "appearance",
        "dark",
      ]);
    });

    it("prefixes the `defaults write` with --set", async () => {
      execFileSucceeds();
      await iosImpl.handler(
        {},
        { udid: RADON_UDID, setting: "reduce-motion", value: "on" },
        radonDevice
      );
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0]![1]).toEqual([
        "simctl",
        "--set",
        RADON_SET,
        "spawn",
        RADON_UDID,
        "defaults",
        "write",
        "com.apple.Accessibility",
        "ReduceMotionEnabled",
        "-bool",
        "YES",
      ]);
    });
  });
});

describe("system-settings Android branch", () => {
  const androidDevice = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" } as const;

  function params(overrides: Partial<SystemSettingsParams>): SystemSettingsParams {
    return { udid: ANDROID_SERIAL, setting: "appearance", value: "dark", ...overrides };
  }

  /** The `adb shell` command string the handler sent for its Nth adb call. */
  function shellCommandAt(index = 0): string {
    return (mockRunAdb.mock.calls[index]![0] as string[])[3]!;
  }

  async function run(overrides: Partial<SystemSettingsParams>) {
    const result = await androidImpl.handler({}, params(overrides), androidDevice);
    return { result, shellCmd: shellCommandAt() };
  }

  it("appearance dark runs `cmd uimode night yes`", async () => {
    const { result, shellCmd } = await run({ value: "dark" });
    expect(mockRunAdb).toHaveBeenCalledTimes(1);
    expect(mockRunAdb.mock.calls[0]![0]).toEqual([
      "-s",
      ANDROID_SERIAL,
      "shell",
      "cmd uimode night yes",
    ]);
    expect(shellCmd).toBe("cmd uimode night yes");
    expect(result).toEqual({ setting: "appearance", value: "dark", applied: "night_mode=yes" });
  });

  it("appearance light runs `cmd uimode night no`", async () => {
    const { shellCmd } = await run({ value: "light" });
    expect(shellCmd).toBe("cmd uimode night no");
  });

  it("increase-contrast maps on/off to high_text_contrast_enabled 1/0", async () => {
    const on = await run({ setting: "increase-contrast", value: "on" });
    expect(on.shellCmd).toBe("settings put secure high_text_contrast_enabled 1");
    expect(on.result.applied).toBe("high_text_contrast_enabled=1");
    mockRunAdb.mockClear();
    const off = await run({ setting: "increase-contrast", value: "off" });
    expect(off.shellCmd).toBe("settings put secure high_text_contrast_enabled 0");
    expect(off.result.applied).toBe("high_text_contrast_enabled=0");
  });

  it("text-size sets a font_scale float for the mapped category", async () => {
    const { result, shellCmd } = await run({ setting: "text-size", value: "accessibility-large" });
    expect(shellCmd).toBe("settings put system font_scale 1.94");
    expect(result.applied).toBe("font_scale=1.94");
  });

  it("every text-size category maps to a defined font_scale (no `undefined` reaches adb)", async () => {
    for (const size of TEXT_SIZE_VALUES) {
      mockRunAdb.mockClear();
      const result = await androidImpl.handler(
        {},
        params({ setting: "text-size", value: size }),
        androidDevice
      );
      expect(shellCommandAt(), size).toMatch(/^settings put system font_scale \d/);
      expect(shellCommandAt(), size).not.toContain("undefined");
      expect(result.applied, size).toMatch(/^font_scale=\d/);
    }
  });

  it("maps every category to the exact font_scale of that Dynamic Type size", async () => {
    // The scale is each iOS body-text point size divided by `large` (17pt) —
    // 14/15/16/17/19/21/23 then the AX range 28/33/40/47/53. Pin every value: a
    // swapped entry silently mis-sizes Android text while still looking
    // well-formed.
    const expected: Record<string, string> = {
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
    for (const [size, scale] of Object.entries(expected)) {
      mockRunAdb.mockClear();
      await androidImpl.handler({}, params({ setting: "text-size", value: size }), androidDevice);
      expect(shellCommandAt(), size).toBe(`settings put system font_scale ${scale}`);
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

  it("invert-colors maps on/off to the inversion flag 1/0", async () => {
    const on = await run({ setting: "invert-colors", value: "on" });
    expect(on.shellCmd).toBe("settings put secure accessibility_display_inversion_enabled 1");
    expect(on.result.applied).toBe("accessibility_display_inversion_enabled=1");
    mockRunAdb.mockClear();
    const off = await run({ setting: "invert-colors", value: "off" });
    expect(off.shellCmd).toBe("settings put secure accessibility_display_inversion_enabled 0");
    expect(off.result.applied).toBe("accessibility_display_inversion_enabled=0");
  });

  it("wifi maps on/off to `svc wifi enable/disable`", async () => {
    const on = await run({ setting: "wifi", value: "on" });
    expect(on.shellCmd).toBe("svc wifi enable");
    expect(on.result.applied).toBe("wifi=enabled");
    mockRunAdb.mockClear();
    const off = await run({ setting: "wifi", value: "off" });
    expect(off.shellCmd).toBe("svc wifi disable");
    expect(off.result.applied).toBe("wifi=disabled");
  });

  it("cellular maps to `svc data enable/disable` (mobile_data)", async () => {
    const on = await run({ setting: "cellular", value: "on" });
    expect(on.shellCmd).toBe("svc data enable");
    expect(on.result.applied).toBe("mobile_data=enabled");
    mockRunAdb.mockClear();
    const off = await run({ setting: "cellular", value: "off" });
    expect(off.shellCmd).toBe("svc data disable");
    expect(off.result.applied).toBe("mobile_data=disabled");
  });

  it("airplane-mode maps to `cmd connectivity airplane-mode enable/disable`", async () => {
    const { result, shellCmd } = await run({ setting: "airplane-mode", value: "on" });
    expect(shellCmd).toBe("cmd connectivity airplane-mode enable");
    expect(result.applied).toBe("airplane_mode=enabled");
    mockRunAdb.mockClear();
    const off = await run({ setting: "airplane-mode", value: "off" });
    expect(off.shellCmd).toBe("cmd connectivity airplane-mode disable");
    expect(off.result.applied).toBe("airplane_mode=disabled");
  });

  it("auto-rotate maps on/off to accelerometer_rotation 1/0", async () => {
    const { result, shellCmd } = await run({ setting: "auto-rotate", value: "on" });
    expect(shellCmd).toBe("settings put system accelerometer_rotation 1");
    expect(result.applied).toBe("accelerometer_rotation=1");
    mockRunAdb.mockClear();
    const off = await run({ setting: "auto-rotate", value: "off" });
    expect(off.shellCmd).toBe("settings put system accelerometer_rotation 0");
    expect(off.result.applied).toBe("accelerometer_rotation=0");
  });

  it("a command-level adb refusal surfaces as ANDROID_SYSTEM_SETTING_FAILED", async () => {
    mockRunAdb.mockRejectedValueOnce(new Error("Failed to write font_scale: Invalid argument"));
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED)
    );
  });

  describe("a failure part-way through a chained write", () => {
    // `reduce-motion` is the one setting that needs several `settings put`
    // calls, chained with `&&`. The chain short-circuits, so the writes before
    // the failing one already landed and the device holds a mix — say so, or
    // the caller reads the error as "nothing changed".
    it("says what the device may already hold, and that a retry finishes it", async () => {
      mockRunAdb.mockRejectedValueOnce(new Error("settings: killed"));
      const rejection = expect(
        androidImpl.handler({}, params({ setting: "reduce-motion", value: "on" }), androidDevice)
      ).rejects;
      await rejection.toThrow(
        /three scales are written one after another, so some may already hold 0/
      );
      await rejection.toThrow(/repeating this call finishes the change/);
    });

    it("says it for a refusal adb reports on stderr too, not only a thrown error", async () => {
      mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr: "settings: permission denied" });
      await expect(
        androidImpl.handler({}, params({ setting: "reduce-motion", value: "off" }), androidDevice)
      ).rejects.toThrow(/some may already hold 1/);
    });

    it("stays off a single-command setting, which either applied or did not", async () => {
      mockRunAdb.mockRejectedValueOnce(new Error("settings: killed"));
      await expect(
        androidImpl.handler(
          {},
          params({ setting: "increase-contrast", value: "on" }),
          androidDevice
        )
      ).rejects.not.toThrow(/may already hold|repeating this call/);
    });
  });

  it("a terminal adb state propagates adb's own failure instead of being relabelled", async () => {
    mockRunAdb.mockRejectedValueOnce(new Error("error: device 'emulator-5554' offline"));
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toThrow(/device 'emulator-5554' offline/);
    await rejection.not.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED));
  });

  it("a transport failure keeps adb's own classification instead of being relabelled", async () => {
    // A wedged/dead device is a transport fault, not a setting refusal — the
    // timeout kind and ANDROID_ADB_COMMAND_FAILED code must survive to the
    // caller, matching settings-permissions' isTransportFailure propagation.
    const transport = new FailureError("adb timed out", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
    mockRunAdb.mockRejectedValueOnce(transport);
    const rejection = expect(
      androidImpl.handler({}, params({ setting: "wifi", value: "on" }), androidDevice)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED));
    await rejection.toSatisfy((err) => getFailureSignal(err)?.error_kind === "timeout");
    await rejection.not.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED));
  });

  // Neither channel alone is a success signal, and the gap is not hypothetical:
  // on an API 24 emulator `cmd uimode night yes` and `cmd connectivity
  // airplane-mode enable` both exit 0 with "No shell command implementation."
  // on stderr while the device stays in light mode with the radios on. adbShell
  // returns stdout only, so an exit-code-only check answers `applied` there.
  describe("a refusal the device prints on stderr while adb exits 0", () => {
    it.each(SYSTEM_SETTINGS)("fails %s instead of reporting it applied", async (setting) => {
      mockRunAdb.mockResolvedValue({ stdout: "", stderr: "No shell command implementation." });
      const rejection = expect(
        androidImpl.handler(
          {},
          params({ setting, value: SETTING_VALUES[setting][0] }),
          androidDevice
        )
      ).rejects;
      await rejection.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED));
      await rejection.toThrow(/No shell command implementation/);
    });

    it("reads every setting off runAdb, never off the stderr-dropping adbShell", async () => {
      for (const setting of SYSTEM_SETTINGS) {
        mockRunAdb.mockClear();
        mockAdbShell.mockClear();
        await androidImpl.handler(
          {},
          params({ setting, value: SETTING_VALUES[setting][0] }),
          androidDevice
        );
        // `location` also probes the API level, which is the one legitimate
        // adbShell call; the change itself never goes through it.
        for (const call of mockAdbShell.mock.calls) {
          expect(call[1], setting).toBe("getprop ro.build.version.sdk");
        }
        expect(mockRunAdb, setting).toHaveBeenCalledTimes(1);
      }
    });

    it("keeps applying when stderr is only whitespace", async () => {
      mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr: "\n" });
      const result = await androidImpl.handler(
        {},
        params({ setting: "wifi", value: "off" }),
        androidDevice
      );
      expect(result.applied).toBe("wifi=disabled");
    });

    it("ignores adb's own daemon-startup banner on stderr when the command succeeded", async () => {
      // First adb call after the shared server died: the client prints its
      // startup banner on stderr and then runs the command normally. The
      // banner is client chatter, not the device's verdict.
      mockRunAdb.mockResolvedValueOnce({
        stdout: "",
        stderr: "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n",
      });
      const result = await androidImpl.handler(
        {},
        params({ setting: "wifi", value: "on" }),
        androidDevice
      );
      expect(result.applied).toBe("wifi=enabled");
    });

    it("ignores adb's server-version-mismatch banner when the command succeeded", async () => {
      // A shared server started by a differently-versioned adb build makes the
      // client print "adb server version (…) doesn't match this client (…);
      // killing…" — no `*` prefix — then restart the server and run the
      // command normally. Still client chatter, not the device's verdict.
      mockRunAdb.mockResolvedValueOnce({
        stdout: "",
        stderr:
          "adb server version (41) doesn't match this client (39); killing...\n* daemon started successfully\n",
      });
      const result = await androidImpl.handler(
        {},
        params({ setting: "wifi", value: "on" }),
        androidDevice
      );
      expect(result.applied).toBe("wifi=enabled");
    });

    it("still fails when a real refusal follows the banner lines", async () => {
      // `svc`'s own usage text, as an API 24 device writes it to stderr while
      // exiting 0. (From API 30 `/system/bin/svc` is a shell script that puts
      // usage on stdout and exits 1, which the exit-code path catches instead.)
      mockRunAdb.mockResolvedValueOnce({
        stdout: "",
        stderr:
          "* daemon not running; starting now at tcp:5037\n" +
          "Control the Wi-Fi manager\n\nusage: svc wifi [enable|disable]\n",
      });
      await expect(
        androidImpl.handler({}, params({ setting: "wifi", value: "on" }), androidDevice)
      ).rejects.toThrow(/Control the Wi-Fi manager/);
    });

    it("classifies the stderr refusal without inventing subprocess metadata", async () => {
      // adb exited 0, so the refusal is device output with no exit code or
      // signal behind it — and it must not be re-read as a transport fault just
      // because the device's own words happen to contain transport wording.
      mockRunAdb.mockResolvedValueOnce({
        stdout: "",
        stderr: "Wi-Fi operation failed: java.io.IOException: connection reset by peer",
      });
      const rejection = expect(
        androidImpl.handler({}, params({ setting: "wifi", value: "on" }), androidDevice)
      ).rejects;
      await rejection.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED));
      await rejection.toSatisfy(
        (err) => getFailureSignal(err)?.failure_stage === "android_system_setting_refused"
      );
    });
  });

  // `settings put secure location_mode` is accepted at every API level but only
  // drives the master switch from Q on: on an API 24 emulator the value flips
  // while `location_providers_allowed` stays `gps` and location keeps working.
  describe("the location API floor", () => {
    it("refuses to report a location change on a device below API 29", async () => {
      mockAdbShell.mockResolvedValueOnce("24");
      const rejection = expect(
        androidImpl.handler({}, params({ setting: "location", value: "off" }), androidDevice)
      ).rejects;
      // The device can't carry the change out and no retry will change that, so
      // this is caller input (400), not a subprocess fault (500) an agent would
      // retry — same class as the iOS "Android-only" rejection.
      await rejection.toThrow(InvalidToolInputError);
      await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
      await rejection.toSatisfy((err) => getFailureSignal(err)?.error_kind === "unsupported");
      await rejection.toSatisfy(
        (err) => getFailureSignal(err)?.failure_stage === "android_system_setting_api_floor"
      );
      await rejection.toThrow(
        new RegExp(`needs Android API 29\\+; ${ANDROID_SERIAL} reports API 24`)
      );
      expect(mockRunAdb).not.toHaveBeenCalled();
    });

    it("applies it on a device at or above the floor", async () => {
      mockAdbShell.mockResolvedValueOnce("29");
      const result = await androidImpl.handler(
        {},
        params({ setting: "location", value: "on" }),
        androidDevice
      );
      expect(shellCommandAt()).toBe("settings put secure location_mode 3");
      expect(result.applied).toBe("location_mode=3");
    });

    it("applies it when the device does not report a parseable API level", async () => {
      mockAdbShell.mockResolvedValueOnce("");
      const result = await androidImpl.handler(
        {},
        params({ setting: "location", value: "off" }),
        androidDevice
      );
      expect(result.applied).toBe("location_mode=0");
    });

    it("is the only setting that probes the API level", async () => {
      for (const setting of SYSTEM_SETTINGS) {
        mockAdbShell.mockClear();
        await androidImpl.handler(
          {},
          params({ setting, value: SETTING_VALUES[setting][0] }),
          androidDevice
        );
        expect(mockAdbShell.mock.calls.length, setting).toBe(setting === "location" ? 1 : 0);
      }
    });
  });
});

describe("system-settings dispatch wiring (through tool.execute)", () => {
  it("declares its per-platform binary dependencies", () => {
    // Losing `requires` would turn a missing adb/xcrun into a raw ENOENT 500
    // instead of the 424 + install-hint contract.
    expect(iosImpl.requires).toEqual(["xcrun"]);
    expect(androidImpl.requires).toEqual(["adb"]);
  });

  // The per-branch tests above call iosImpl/androidImpl directly, so they can't
  // catch a mis-wired dispatch table (`ios: androidImpl, android: iosImpl`
  // typechecks — both impls share generics — and would run simctl against
  // Android serials and adb against iOS UDIDs). These drive the real `execute`
  // with a valid value on each shaped udid and assert each platform reaches its
  // OWN binary. Dep cache is primed so `ensureDeps` doesn't shell out to
  // `command -v` and perturb `execFileMock` call counts.
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  // The priming is module-level state in check-deps, so drop it again rather
  // than leaking it into whatever describe is added after this one.
  afterEach(() => __resetDepCacheForTests());

  it("an iOS udid runs `xcrun simctl ui`, never adb", async () => {
    execFileSucceeds();
    const result = await systemSettingsTool.execute!(
      {},
      { udid: IOS_UDID, setting: "appearance", value: "dark" }
    );
    expect(result.applied).toBe("appearance=dark");
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect((args as string[]).slice(0, 3)).toEqual(["simctl", "ui", IOS_UDID]);
    expect(mockAdbShell).not.toHaveBeenCalled();
    expect(mockRunAdb).not.toHaveBeenCalled();
  });

  it("an Android serial runs over adb, never xcrun", async () => {
    const result = await systemSettingsTool.execute!(
      {},
      { udid: ANDROID_SERIAL, setting: "appearance", value: "light" }
    );
    expect(result.applied).toBe("night_mode=no");
    expect(mockRunAdb).toHaveBeenCalledWith(
      ["-s", ANDROID_SERIAL, "shell", "cmd uimode night no"],
      { timeoutMs: 15_000 }
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// The MCP client caps a tool call at 30s per attempt and then replays it up to
// four more times (`FETCH_TIMEOUT_MS` / `MAX_RETRIES` in
// packages/argent-mcp/src/mcp-server.ts); `system-settings` claims no
// `longRunning`, so it gets that cap. Every timeout on a handler's path runs in
// SERIES, so their sum is what the tool actually needs to answer a wedged
// CoreSimulatorService or adb server. Above the cap the tool can never surface
// its own diagnostic — the client aborts first and re-POSTs while the abandoned
// `simctl`/`adb` child keeps running against the same wedged service.
const MCP_CLIENT_ATTEMPT_BUDGET_MS = 30_000;
// tool-server does not depend on argent-mcp, so the number above is a copy.
// Read the real one out of the client's source and fail here if they drift —
// a lowered cap would otherwise leave both sums quietly over budget.
function mcpClientFetchTimeoutMs(): number {
  const source = readFileSync(
    path.join(__dirname, "..", "..", "argent-mcp", "src", "mcp-server.ts"),
    "utf8"
  );
  const match = /const FETCH_TIMEOUT_MS = ([\d_]+);/.exec(source);
  if (!match) throw new Error("FETCH_TIMEOUT_MS not found in argent-mcp/src/mcp-server.ts");
  return Number(match[1]!.replace(/_/g, ""));
}
// A real margin, not just "<": a slow-but-completing call on a loaded machine
// must still land inside the client's attempt.
const MIN_BUDGET_MARGIN_MS = 5_000;

describe("worst-case time budget vs the MCP client's per-attempt cap", () => {
  it("budgets against the cap the MCP client actually arms", () => {
    expect(mcpClientFetchTimeoutMs()).toBe(MCP_CLIENT_ATTEMPT_BUDGET_MS);
  });

  it("the iOS `simctl ui` path fits, dependency check and tvOS probe included", () => {
    // `ensureDeps(["xcrun"])` → one PATH lookup, then `isTvOsSimulator` → one
    // `simctl list devices --json`, then the `simctl ui` call itself. That is
    // the whole serial path in the shipped configuration: `deviceSetForUdid`
    // returns without a probe when no `ios.additionalDeviceSets` are set, and
    // with the UDID already memoized by the tvOS probe's own listing otherwise.
    const worstCase = PATH_LOOKUP_TIMEOUT_MS + SIMCTL_LIST_TIMEOUT_MS + SIMCTL_UI_TIMEOUT_MS;
    expect(worstCase).toBeLessThan(MCP_CLIENT_ATTEMPT_BUDGET_MS);
    expect(MCP_CLIENT_ATTEMPT_BUDGET_MS - worstCase).toBeGreaterThanOrEqual(MIN_BUDGET_MARGIN_MS);
  });

  it("the iOS `defaults` path fits too, on its own simctl ceiling", () => {
    // `reduce-motion` and `invert-colors` reach the device through
    // `simctl spawn`, which carries a different constant from the three
    // `simctl ui` settings — the budget has to hold for both mechanisms.
    const worstCase = PATH_LOOKUP_TIMEOUT_MS + SIMCTL_LIST_TIMEOUT_MS + SIMCTL_SPAWN_TIMEOUT_MS;
    expect(worstCase).toBeLessThan(MCP_CLIENT_ATTEMPT_BUDGET_MS);
    expect(MCP_CLIENT_ATTEMPT_BUDGET_MS - worstCase).toBeGreaterThanOrEqual(MIN_BUDGET_MARGIN_MS);
  });

  it("the Android path fits, dependency check and API-level probe included", () => {
    // `ensureDeps(["adb"])` → one PATH lookup (the resolver's SDK-root fallback
    // is filesystem `access`, not a subprocess), then `location`'s `getprop`
    // probe (the only setting that runs one), then the `adb shell` that applies
    // the change.
    const worstCase = PATH_LOOKUP_TIMEOUT_MS + ENRICH_TIMEOUT_MS + ADB_SETTING_TIMEOUT_MS;
    expect(worstCase).toBeLessThan(MCP_CLIENT_ATTEMPT_BUDGET_MS);
    expect(MCP_CLIENT_ATTEMPT_BUDGET_MS - worstCase).toBeGreaterThanOrEqual(MIN_BUDGET_MARGIN_MS);
  });
});

describe("a change that would cut the adb link it travels over", () => {
  const WIRELESS_SERIAL = "192.168.1.42:5555";
  const USB_SERIAL = "R58M1234ABC";

  function run(udid: string, setting: string, value: string) {
    return androidImpl.handler(
      {},
      { udid, setting, value } as SystemSettingsParams,
      { id: udid, platform: "android", kind: "device" } as const
    );
  }

  // Wireless debugging carries adb over the device's own Wi-Fi. Switching that
  // off applies the change and then strands the device: no response, and no
  // later call — including the one that would undo it — can reach it.
  // adb names a device it found over mDNS by the service instance, so this
  // serial carries no address at all — the shape Android 11+ wireless debugging
  // produces, and the one a `host:port` test alone would miss.
  const MDNS_SERIAL = "adb-39121FDJG0026R-tGGCXo._adb-tls-connect._tcp";

  it.each([
    [WIRELESS_SERIAL, "wifi", "off"],
    [WIRELESS_SERIAL, "airplane-mode", "on"],
    [MDNS_SERIAL, "wifi", "off"],
    [MDNS_SERIAL, "airplane-mode", "on"],
  ])("refuses %s %s=%s", async (udid, setting, value) => {
    const rejection = expect(run(udid, setting, value)).rejects;
    await rejection.toThrow(InvalidToolInputError);
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toSatisfy(
      (err) => getFailureSignal(err)?.failure_stage === "android_system_setting_self_disconnect"
    );
    expect(mockRunAdb).not.toHaveBeenCalled();
  });

  it.each([
    ["wifi", "off"],
    ["airplane-mode", "on"],
  ])("names the recovery when it refuses %s=%s", async (setting, value) => {
    const rejection = expect(run(WIRELESS_SERIAL, setting, value)).rejects;
    await rejection.toThrow(InvalidToolInputError);
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toSatisfy(
      (err) => getFailureSignal(err)?.failure_stage === "android_system_setting_self_disconnect"
    );
    // The recovery is not obvious from the failure alone, so it is named.
    await rejection.toThrow(/Use a USB connection/);
    expect(mockRunAdb).not.toHaveBeenCalled();
  });

  // Only the two that take the Wi-Fi link down, only in the direction that takes
  // it down, and only where adb actually rides that link — a blanket refusal
  // would block changes that work fine. A loopback serial is a forwarded port
  // (docker-android, a tunnelled emulator), where the remedy the refusal names
  // — use USB — does not even exist.
  it.each([
    [WIRELESS_SERIAL, "wifi", "on"],
    [WIRELESS_SERIAL, "airplane-mode", "off"],
    [WIRELESS_SERIAL, "cellular", "off"],
    [ANDROID_SERIAL, "wifi", "off"],
    [ANDROID_SERIAL, "airplane-mode", "on"],
    [USB_SERIAL, "wifi", "off"],
    [USB_SERIAL, "airplane-mode", "on"],
    ["localhost:5555", "wifi", "off"],
    ["127.0.0.1:5555", "wifi", "off"],
    ["[::1]:5555", "airplane-mode", "on"],
  ])("still applies %s %s=%s", async (udid, setting, value) => {
    await expect(run(udid, setting, value)).resolves.toMatchObject({ setting, value });
    expect(mockRunAdb).toHaveBeenCalledTimes(1);
  });

  it("names the wirelessly debugged device it refused", async () => {
    // One session can hold several serials; the message has to say which.
    await expect(run(WIRELESS_SERIAL, "wifi", "off")).rejects.toThrow(
      new RegExp(WIRELESS_SERIAL.replace(/\./g, "\\."))
    );
  });
});

describe("what a failure carries", () => {
  const androidDevice = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" } as const;

  function androidParams(setting = "wifi", value = "on"): SystemSettingsParams {
    return { udid: ANDROID_SERIAL, setting, value } as SystemSettingsParams;
  }

  // The telemetry fields are what a failure is bucketed by; a wrong or dropped
  // one silently merges this tool's failures into another's bucket.
  it("tags an adb throw with adb's own subprocess metadata", async () => {
    // The shape `runAdb` really throws: `describeAdbFailure` reads the exit code
    // off the raw `execFile` rejection and puts it in the signal, and the
    // FailureError it returns carries no `code` of its own — so re-deriving the
    // metadata from that wrapper instead of inheriting it finds nothing.
    mockRunAdb.mockRejectedValueOnce(
      new FailureError("adb -s emulator-5554 shell svc wifi enable failed: boom", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
        failure_exit_code: 7,
      })
    );
    const err = await androidImpl
      .handler({}, androidParams(), androidDevice)
      .catch((e: unknown) => e);
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED);
    expect(signal?.failure_stage).toBe("android_system_setting_adb");
    expect(signal?.failure_area).toBe("tool_server");
    expect(signal?.error_kind).toBe("subprocess");
    expect(signal?.failure_command).toBe("adb");
    expect(signal?.failure_exit_code).toBe(7);
    // Named so an agent can tell which of several devices refused.
    expect((err as Error).message).toContain(ANDROID_SERIAL);
  });

  it("tags a simctl throw with xcrun's subprocess metadata", async () => {
    execFileFails("kaboom");
    const err = await iosImpl
      .handler({}, { udid: IOS_UDID, setting: "appearance", value: "dark" }, IOS_DEVICE)
      .catch((e: unknown) => e);
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED);
    expect(signal?.failure_stage).toBe("ios_system_setting_apply");
    expect(signal?.failure_area).toBe("tool_server");
    expect(signal?.error_kind).toBe("subprocess");
    expect(signal?.failure_command).toBe("xcrun_simctl");
    expect((err as Error).message).toContain(IOS_UDID);
  });

  it("tells an agent to boot the simulator rather than blame the runtime", async () => {
    // The two hints are mutually exclusive by construction, and a refusal whose
    // wording trips both regexes is what that ordering is for: "boot it" is
    // actionable, "try a newer runtime" sends the agent installing runtimes to
    // fix a simulator it only had to boot.
    execFileFails("Operation not supported while the device is not booted.");
    const err = await iosImpl
      .handler({}, { udid: IOS_UDID, setting: "reduce-motion", value: "on" }, IOS_DEVICE)
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("use boot-device");
    expect((err as Error).message).not.toContain("newer runtime");
  });

  it("lists what iOS does support when it rejects an Android-only setting", async () => {
    const err = await iosImpl
      .handler({}, { udid: IOS_UDID, setting: "wifi", value: "on" }, IOS_DEVICE)
      .catch((e: unknown) => e);
    // Without the list the agent has to guess which of the ten to retry with.
    for (const supported of IOS_SUPPORTED_SETTINGS) {
      expect((err as Error).message).toContain(supported);
    }
  });

  it("reads an indented daemon banner as chatter, not as the device's refusal", async () => {
    // adb indents the banner on some hosts; matching it only at column 0 turns
    // a successful call into a reported failure.
    mockRunAdb.mockResolvedValueOnce({ stdout: "", stderr: "  * daemon started successfully" });
    await expect(androidImpl.handler({}, androidParams(), androidDevice)).resolves.toMatchObject({
      applied: "wifi=enabled",
    });
  });

  it("propagates a daemon-transport failure instead of reporting a refusal", async () => {
    // The command never reached the device, so calling it a setting refusal
    // would blame the device for the adb server restarting underneath it.
    const transport = new Error("protocol fault (couldn't read status): Connection reset by peer");
    mockRunAdb.mockRejectedValueOnce(transport);
    await expect(androidImpl.handler({}, androidParams(), androidDevice)).rejects.toBe(transport);
  });

  it("probes the API level of the device the call names", async () => {
    mockAdbShell.mockResolvedValueOnce("34");
    await androidImpl.handler({}, androidParams("location", "on"), androidDevice);
    expect(mockAdbShell).toHaveBeenCalledWith(ANDROID_SERIAL, "getprop ro.build.version.sdk", {
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
  });
});

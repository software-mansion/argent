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
    isTerminalAdbError: actual.isTerminalAdbError,
  };
});

import type { DeviceInfo } from "@argent/registry";
import { FAILURE_CODES, getFailureSignal, zodObjectToJsonSchema } from "@argent/registry";
import { settingsPermissionsTool } from "../src/tools/settings-permissions";
import { iosImpl } from "../src/tools/settings-permissions/platforms/ios";
import { androidImpl } from "../src/tools/settings-permissions/platforms/android";
import type { SettingsPermissionsParams } from "../src/tools/settings-permissions/types";
import { adbShell } from "../src/utils/adb";

const mockAdbShell = vi.mocked(adbShell);

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";

const iosDevice: DeviceInfo = { id: IOS_UDID, platform: "ios", kind: "simulator" };
const androidDevice: DeviceInfo = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" };

// FailureError attaches its FailureSignal under a non-enumerable symbol, so
// toMatchObject can't see it — assert through the public accessor instead.
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => getFailureSignal(err)?.error_code === code;
}

// The promisified execFile mock: resolve = success, reject-style = call with error.
function execFileSucceeds(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: string) => void) => {
      cb(null, "");
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

// Default adb behavior: the `pm path` existence preflight finds the package,
// and every mutating pm command succeeds silently (pm's real success shape).
function adbDefaults(overrides?: (cmd: string) => string | Promise<string> | undefined): void {
  mockAdbShell.mockImplementation(async (_serial, cmd) => {
    const overridden = overrides?.(cmd);
    if (overridden !== undefined) return overridden;
    if (cmd.startsWith("pm path")) return "package:/data/app/base.apk";
    return "";
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  mockAdbShell.mockReset();
  adbDefaults();
});

describe("settings-permissions schema", () => {
  const schema = settingsPermissionsTool.zodSchema!;

  it("accepts grant with a bundleId", () => {
    const parsed = schema.safeParse({
      udid: IOS_UDID,
      action: "grant",
      permission: "camera",
      bundleId: "com.example.app",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects grant without a bundleId", () => {
    const parsed = schema.safeParse({ udid: IOS_UDID, action: "grant", permission: "camera" });
    expect(parsed.success).toBe(false);
  });

  it("rejects deny without a bundleId", () => {
    const parsed = schema.safeParse({ udid: IOS_UDID, action: "deny", permission: "photos" });
    expect(parsed.success).toBe(false);
  });

  it("accepts reset without a bundleId (device-wide reset on iOS)", () => {
    const parsed = schema.safeParse({ udid: IOS_UDID, action: "reset", permission: "location" });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown permissions and actions", () => {
    expect(
      schema.safeParse({
        udid: IOS_UDID,
        action: "grant",
        permission: "bluetooth",
        bundleId: "com.example.app",
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        udid: IOS_UDID,
        action: "revoke",
        permission: "camera",
        bundleId: "com.example.app",
      }).success
    ).toBe(false);
  });

  it("rejects an empty udid", () => {
    const parsed = schema.safeParse({
      udid: "",
      action: "grant",
      permission: "camera",
      bundleId: "com.example.app",
    });
    expect(parsed.success).toBe(false);
  });

  // Same attack surface as launch-app/restart-app: bundleId is interpolated
  // into an `adb shell` string, so shell metacharacters must never validate.
  const injectionPayloads = [
    "com.foo;rm -rf /sdcard",
    "com.foo`touch /sdcard/owned`",
    "com.foo$(touch /sdcard/owned)",
    "com.foo && reboot",
    "com.foo\nmalicious",
    "com.foo'; id; echo '",
    "--user",
    "-X",
  ];
  for (const payload of injectionPayloads) {
    it(`rejects bundleId with shell metachars: ${JSON.stringify(payload)}`, () => {
      const parsed = schema.safeParse({
        udid: ANDROID_SERIAL,
        action: "grant",
        permission: "camera",
        bundleId: payload,
      });
      expect(parsed.success).toBe(false);
    });
  }

  it("derives a sane MCP JSON schema despite the superRefine", () => {
    // This is the first tool schema built as z.object(...).superRefine(...);
    // pin the derivation so a zod upgrade can't silently break the
    // MCP-visible schema (zod 4 keeps refinements inside the ZodObject and
    // z.toJSONSchema simply omits them).
    const json = zodObjectToJsonSchema(schema) as {
      required?: string[];
      properties?: Record<string, { pattern?: string; enum?: string[] }>;
    };
    expect(json.required).toEqual(["udid", "action", "permission"]);
    expect(json.properties?.bundleId?.pattern).toBe("^[A-Za-z_][A-Za-z0-9._-]*$");
    expect(json.properties?.action?.enum).toEqual(["grant", "deny", "reset"]);
    expect(json.properties?.permission?.enum).toHaveLength(11);
  });
});

describe("settings-permissions iOS branch", () => {
  function params(overrides: Partial<SettingsPermissionsParams>): SettingsPermissionsParams {
    return {
      udid: IOS_UDID,
      action: "grant",
      permission: "microphone",
      bundleId: "com.example.app",
      ...overrides,
    };
  }

  it("grant runs `simctl privacy <udid> grant <service> <bundleId>`", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler({}, params({}), iosDevice);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect(args).toEqual(["simctl", "privacy", IOS_UDID, "grant", "microphone", "com.example.app"]);
    expect(result).toEqual({
      action: "grant",
      permission: "microphone",
      bundleId: "com.example.app",
      applied: ["microphone"],
    });
  });

  it("deny maps to simctl's `revoke`", async () => {
    execFileSucceeds();
    await iosImpl.handler({}, params({ action: "deny", permission: "photos" }), iosDevice);
    const [, args] = execFileMock.mock.calls[0]!;
    expect(args).toEqual(["simctl", "privacy", IOS_UDID, "revoke", "photos", "com.example.app"]);
  });

  it("reset without bundleId omits the bundle argument (all apps)", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ action: "reset", permission: "location-always", bundleId: undefined }),
      iosDevice
    );
    const [, args] = execFileMock.mock.calls[0]!;
    expect(args).toEqual(["simctl", "privacy", IOS_UDID, "reset", "location-always"]);
    expect(result.bundleId).toBeUndefined();
  });

  it("notifications is rejected as unsupported without calling simctl", async () => {
    await expect(
      iosImpl.handler({}, params({ permission: "notifications" }), iosDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("an 'invalid service' simctl failure surfaces as unsupported", async () => {
    execFileFails("Invalid privacy service: camera");
    await expect(
      iosImpl.handler({}, params({ permission: "camera" }), iosDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED));
  });

  it("other simctl failures surface as IOS_SETTINGS_PERMISSION_FAILED", async () => {
    execFileFails("Invalid device: nope");
    await expect(iosImpl.handler({}, params({}), iosDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED)
    );
  });

  it("a shutdown-simulator failure carries a boot-device hint", async () => {
    execFileFails(
      "An error was encountered processing the command (domain=NSCocoaErrorDomain, code=405):\nUnable to lookup in current state: Shutdown"
    );
    await expect(iosImpl.handler({}, params({}), iosDevice)).rejects.toThrow(
      /must be booted first — use boot-device/
    );
  });
});

describe("settings-permissions Android branch", () => {
  function params(overrides: Partial<SettingsPermissionsParams>): SettingsPermissionsParams {
    return {
      udid: ANDROID_SERIAL,
      action: "grant",
      permission: "camera",
      bundleId: "com.example.app",
      ...overrides,
    };
  }

  it("grant runs `pm grant` for the mapped permission", async () => {
    const result = await androidImpl.handler({}, params({}), androidDevice);
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      "pm grant 'com.example.app' android.permission.CAMERA",
      expect.anything()
    );
    expect(result.applied).toEqual(["android.permission.CAMERA"]);
    expect(result.skipped).toBeUndefined();
  });

  it("deny runs `pm revoke`", async () => {
    await androidImpl.handler({}, params({ action: "deny" }), androidDevice);
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      "pm revoke 'com.example.app' android.permission.CAMERA",
      expect.anything()
    );
  });

  it("reset revokes and clears the user-set permission flags", async () => {
    await androidImpl.handler({}, params({ action: "reset" }), androidDevice);
    const commands = mockAdbShell.mock.calls.map((c) => c[1]);
    expect(commands).toEqual([
      "pm path 'com.example.app'",
      "pm revoke 'com.example.app' android.permission.CAMERA",
      "pm clear-permission-flags 'com.example.app' android.permission.CAMERA user-set user-fixed",
    ]);
  });

  it("reset skips clear-permission-flags when the revoke itself fails", async () => {
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm revoke")) throw new Error("pm revoke exited with code 255");
      return undefined;
    });
    await expect(
      androidImpl.handler({}, params({ action: "reset" }), androidDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED));
    const commands = mockAdbShell.mock.calls.map((c) => c[1]);
    expect(commands.some((c) => c.startsWith("pm clear-permission-flags"))).toBe(false);
  });

  it("reset does not count a permission whose flags could not be cleared", async () => {
    // Revoke succeeds but the flags survive: the app stays "user-denied" and
    // the dialog will NOT reappear — that's a deny, not a reset.
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm clear-permission-flags")) {
        throw new Error("pm clear-permission-flags exited with code 255");
      }
      return undefined;
    });
    await expect(
      androidImpl.handler({}, params({ action: "reset" }), androidDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED));
  });

  it("a transport-level adb failure at the preflight is rethrown, not mislabeled as not-installed", async () => {
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm path")) throw new Error("adb: device 'emulator-5554' not found");
      return undefined;
    });
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toThrow(/device 'emulator-5554' not found/);
    await rejection.not.toThrow(/not installed/);
  });

  it("a package pm cannot resolve fails with not-found instead of a silent success", async () => {
    // pm grant/revoke exit 0 for an unknown package (observed on API 34), so
    // the handler must catch it at the `pm path` preflight.
    mockAdbShell.mockImplementation(async (_serial, cmd) => {
      if (cmd.startsWith("pm path")) throw new Error("pm path exited with code 1");
      return "";
    });
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED)
    );
    const commands = mockAdbShell.mock.calls.map((c) => c[1]);
    expect(commands).toEqual(["pm path 'com.example.app'"]);
  });

  it("location fans out to fine + coarse", async () => {
    const result = await androidImpl.handler({}, params({ permission: "location" }), androidDevice);
    expect(result.applied).toEqual([
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
    ]);
  });

  it("granting location-always also grants the foreground location permissions", async () => {
    // Background location alone is unusable on Android — the OS requires the
    // foreground permissions to be granted too.
    const result = await androidImpl.handler(
      {},
      params({ permission: "location-always" }),
      androidDevice
    );
    expect(result.applied).toEqual([
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    ]);
  });

  it("denying location-always touches only the background permission", async () => {
    const result = await androidImpl.handler(
      {},
      params({ action: "deny", permission: "location-always" }),
      androidDevice
    );
    expect(result.applied).toEqual(["android.permission.ACCESS_BACKGROUND_LOCATION"]);
  });

  it("partial pm failures land in `skipped`, not an error", async () => {
    // photos → READ_MEDIA_IMAGES ok, READ_MEDIA_VIDEO ok, READ_EXTERNAL_STORAGE rejected
    adbDefaults((cmd) => {
      if (cmd.includes("READ_EXTERNAL_STORAGE")) {
        return "Exception occurred while executing 'grant':\njava.lang.SecurityException: Permission android.permission.READ_EXTERNAL_STORAGE requested by com.example.app is not a changeable permission type";
      }
      return undefined;
    });
    const result = await androidImpl.handler({}, params({ permission: "photos" }), androidDevice);
    expect(result.applied).toEqual([
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
    ]);
    expect(result.skipped).toEqual(["android.permission.READ_EXTERNAL_STORAGE"]);
  });

  it("pm rejecting every mapped permission raises ANDROID_SETTINGS_PERMISSION_FAILED", async () => {
    adbDefaults((cmd) =>
      cmd.startsWith("pm grant")
        ? "Exception occurred while executing 'grant':\njava.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA\n\tat com.android.server.pm.permission.PermissionManagerServiceImpl.grantRuntimePermissionInternal(PermissionManagerServiceImpl.java:1423)\n\tat android.os.Binder.execTransact(Binder.java:1275)"
        : undefined
    );
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED));
    // The surfaced message keeps the exception line but drops the Java stack
    // frames (they'd bloat every error the agent sees).
    await rejection.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("has not requested permission") &&
        !err.message.includes("at com.android.server")
    );
  });

  it("a thrown adb error (non-zero exit) counts as a pm failure", async () => {
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm grant")) throw new Error("pm grant exited with code 255");
      return undefined;
    });
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED)
    );
  });

  it("reminders is rejected as unsupported (no Android equivalent)", async () => {
    await expect(
      androidImpl.handler({}, params({ permission: "reminders" }), androidDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED));
    expect(mockAdbShell).not.toHaveBeenCalled();
  });

  it("reset without bundleId is rejected on Android", async () => {
    await expect(
      androidImpl.handler({}, params({ action: "reset", bundleId: undefined }), androidDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED));
    expect(mockAdbShell).not.toHaveBeenCalled();
  });
});

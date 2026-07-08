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
    // Real classifier — the Android handler uses it to tell a transport/timeout
    // failure (propagate) from a pm rejection (fold into `skipped`).
    isTerminalAdbError: actual.isTerminalAdbError,
  };
});

import type { DeviceInfo } from "@argent/registry";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  zodObjectToJsonSchema,
} from "@argent/registry";
import { settingsPermissionsTool } from "../src/tools/settings-permissions";
import { iosImpl } from "../src/tools/settings-permissions/platforms/ios";
import { androidImpl } from "../src/tools/settings-permissions/platforms/android";
import type { SettingsPermissionsParams } from "../src/tools/settings-permissions/types";
import { adbShell } from "../src/utils/adb";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const mockAdbShell = vi.mocked(adbShell);

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";

const iosDevice: DeviceInfo = { id: IOS_UDID, platform: "ios", kind: "simulator" };
const androidDevice: DeviceInfo = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" };

// FailureError attaches its FailureSignal under a non-enumerable symbol, so
// toMatchObject can't see it — assert through the public accessor instead.
// The `typeof code === "string"` guard is load-bearing: if a FAILURE_CODES
// member ever resolves to `undefined` (e.g. vitest loading a stale @argent/
// registry dist that predates a new code), the matcher would otherwise degrade
// to `undefined === undefined` and pass for *any* rejection — masking real
// failures. The string check turns that into an always-false matcher so the
// affected assertions fail loudly instead. (See the FAILURE_CODES type test.)
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

// The promisified execFile mock: resolve = success, reject-style = call with error.
// Resolves with a `{ stdout, stderr }` object so a consumer that reads `.stdout`
// (sim-remote's `run`, used by the ios-remote branch) sees the same shape the
// real execFile custom-promisify yields; handlers that ignore the return
// (local xcrun path) are unaffected.
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

// Default adb behavior: the `pm list packages` existence preflight finds the
// package (it prints a `package:<name>` line and exits 0), and every mutating pm
// command succeeds silently (pm's real success shape).
function adbDefaults(overrides?: (cmd: string) => string | Promise<string> | undefined): void {
  mockAdbShell.mockImplementation(async (_serial, cmd) => {
    const overridden = overrides?.(cmd);
    if (overridden !== undefined) return overridden;
    if (cmd.startsWith("pm list packages")) return "package:com.example.app";
    return "";
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  mockAdbShell.mockReset();
  adbDefaults();
});

describe("settings-permissions failure codes are defined", () => {
  // Guards the whole suite: `failsWith` compares against these constants, and a
  // stale @argent/registry dist that predates them would resolve them to
  // `undefined`, silently defanging every `failsWith` assertion. Assert they are
  // real strings so a missing code fails here loudly instead of hiding elsewhere.
  it("resolves the three settings-permissions codes to strings", () => {
    for (const code of [
      "SETTINGS_PERMISSION_UNSUPPORTED",
      "IOS_SETTINGS_PERMISSION_FAILED",
      "ANDROID_SETTINGS_PERMISSION_FAILED",
    ] as const) {
      expect(typeof FAILURE_CODES[code], code).toBe("string");
    }
  });
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

  it("rejects reset without a bundleId (bundleId is required for every action)", () => {
    // Device-wide reset is gone: simctl's no-bundleId reset silently leaves
    // existing per-app grants intact on recent iOS, so the tool is per-app only.
    const parsed = schema.safeParse({ udid: IOS_UDID, action: "reset", permission: "location" });
    expect(parsed.success).toBe(false);
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

  it("derives a sane MCP JSON schema with bundleId required for every action", () => {
    // bundleId is a plain required field now (no superRefine), so it must appear
    // in the JSON schema's `required` list — pin the derivation so a zod upgrade
    // can't silently drop it and let a bundleId-less call reach the handler.
    const json = zodObjectToJsonSchema(schema) as {
      required?: string[];
      properties?: Record<string, { pattern?: string; enum?: string[] }>;
    };
    expect(json.required).toEqual(["udid", "action", "permission", "bundleId"]);
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

  it("reset is per-app: `simctl privacy <udid> reset <service> <bundleId>`", async () => {
    // A device-wide reset (no bundleId) is intentionally not supported — it is a
    // no-op for existing per-app grants on recent iOS, so reset always targets
    // the one app and echoes its bundleId back.
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ action: "reset", permission: "location-always" }),
      iosDevice
    );
    const [, args] = execFileMock.mock.calls[0]!;
    expect(args).toEqual([
      "simctl",
      "privacy",
      IOS_UDID,
      "reset",
      "location-always",
      "com.example.app",
    ]);
    expect(result.bundleId).toBe("com.example.app");
  });

  it("notifications is rejected as unsupported without calling simctl", async () => {
    await expect(
      iosImpl.handler({}, params({ permission: "notifications" }), iosDevice)
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a camera failure surfaces IOS_SETTINGS_PERMISSION_FAILED with a list-services hint", async () => {
    // simctl rejects a service it doesn't model with a generic CoreSimulator
    // NSError, indistinguishable from any other failure — so instead of parsing
    // its wording, camera (the one service simulators may lack) always carries a
    // hint to list the supported services.
    execFileFails(
      "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=1):\n" +
        "Simulator device failed to complete the requested operation.\nOperation not permitted\n" +
        "Underlying error (domain=NSPOSIXErrorDomain, code=1):\n\tFailed to set access"
    );
    const rejection = expect(
      iosImpl.handler({}, params({ permission: "camera" }), iosDevice)
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED));
    await rejection.toThrow(/run `xcrun simctl privacy` to list the services it supports/);
  });

  it("a non-camera failure does not get the camera hint", async () => {
    execFileFails("Simulator device failed to complete the requested operation.");
    await expect(
      iosImpl.handler({}, params({ permission: "microphone" }), iosDevice)
    ).rejects.not.toThrow(/list the services it supports/);
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

  it("a camera failure on a shutdown simulator gets the boot-device hint, not the camera hint", async () => {
    // cameraHint is gated on `!shutdownHint`, so a shutdown error must win even
    // for camera — otherwise the agent is told to list services when the real
    // fix is to boot the device. Pins that guard (the camera-hint and shutdown
    // tests above never pair the two).
    execFileFails(
      "An error was encountered processing the command (domain=NSCocoaErrorDomain, code=405):\nUnable to lookup in current state: Shutdown"
    );
    const rejection = expect(
      iosImpl.handler({}, params({ permission: "camera" }), iosDevice)
    ).rejects;
    await rejection.toThrow(/must be booted first — use boot-device/);
    await rejection.not.toThrow(/list the services it supports/);
  });

  it("maps each supported permission to its simctl privacy service (identity)", async () => {
    // Lock IOS_SERVICES: microphone/photos/location-always are asserted above,
    // this pins the rest so an accidental empty/typo (which would surface a false
    // "unsupported") is caught — notably `reminders`, the sole iOS-only service.
    execFileSucceeds();
    const cases: Array<[SettingsPermissionsParams["permission"], string]> = [
      ["contacts", "contacts"],
      ["calendar", "calendar"],
      ["location", "location"],
      ["media-library", "media-library"],
      ["motion", "motion"],
      ["reminders", "reminders"],
    ];
    for (const [permission, service] of cases) {
      execFileMock.mockClear();
      const result = await iosImpl.handler({}, params({ permission }), iosDevice);
      // `location` grant runs a `get_app_container` install probe first, so the
      // privacy call isn't necessarily calls[0] — find it by verb.
      const privacyCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[1] === "privacy");
      expect(privacyCall?.[1], permission).toEqual([
        "simctl",
        "privacy",
        IOS_UDID,
        "grant",
        service,
        "com.example.app",
      ]);
      expect(result.applied, permission).toEqual([service]);
    }
  });

  it("photos fans out to the `photos` and `photos-add` TCC services", async () => {
    // add-only access lives in the separate `photos-add` service, so a deny/reset
    // that touched only `photos` would leave a surviving add-only grant. Both are
    // targeted; `photos-add` is best-effort (see the next test).
    execFileSucceeds();
    for (const action of ["grant", "deny", "reset"] as const) {
      execFileMock.mockClear();
      const result = await iosImpl.handler({}, params({ action, permission: "photos" }), iosDevice);
      const services = execFileMock.mock.calls.map((c) => (c[1] as string[])[4]);
      expect(services, action).toEqual(["photos", "photos-add"]);
      expect(result.applied, action).toEqual(["photos", "photos-add"]);
    }
  });

  it("a runtime that rejects the best-effort `photos-add` service still succeeds on `photos`", async () => {
    // `photos` (the primary) must succeed; a `photos-add` this runtime doesn't
    // model must be skipped silently, not fail the whole action.
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: string) => void) => {
        if (args[4] === "photos-add") {
          cb(Object.assign(new Error("Failed to set access"), { code: 1 }));
        } else {
          cb(null, "");
        }
      }
    );
    const result = await iosImpl.handler({}, params({ permission: "photos" }), iosDevice);
    expect(result.applied).toEqual(["photos"]);
  });

  it("granting location to an uninstalled app fails instead of a false success", async () => {
    // location auth isn't TCC-backed and doesn't persist pre-install, so a grant
    // to a missing app records nothing — verify install first (get_app_container
    // exits non-zero for a missing app) and reject rather than return applied.
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: string) => void) => {
        if (args[0] === "simctl" && args[1] === "get_app_container") {
          cb(Object.assign(new Error("No such file or directory"), { code: 1 }));
        } else {
          cb(null, "");
        }
      }
    );
    for (const permission of ["location", "location-always"] as const) {
      const rejection = expect(
        iosImpl.handler({}, params({ action: "grant", permission }), iosDevice)
      ).rejects;
      await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED));
      await rejection.toThrow(/the app is not installed/);
    }
    // The privacy grant must never have run for the missing app.
    const ranPrivacy = execFileMock.mock.calls.some((c) => (c[1] as string[])[1] === "privacy");
    expect(ranPrivacy).toBe(false);
  });

  it("granting location to an installed app runs the privacy grant", async () => {
    // get_app_container succeeds (installed) → the grant proceeds normally.
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ action: "grant", permission: "location" }),
      iosDevice
    );
    expect(result.applied).toEqual(["location"]);
    const privacyCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[1] === "privacy");
    expect(privacyCall?.[1]).toEqual([
      "simctl",
      "privacy",
      IOS_UDID,
      "grant",
      "location",
      "com.example.app",
    ]);
  });

  it("denying or resetting location does NOT require the app to be installed", async () => {
    // The install guard is grant-only: a deny/reset of location for a missing
    // app is a harmless no-op on device, so it must not probe install state.
    execFileSucceeds();
    for (const action of ["deny", "reset"] as const) {
      execFileMock.mockClear();
      await iosImpl.handler({}, params({ action, permission: "location" }), iosDevice);
      const probed = execFileMock.mock.calls.some(
        (c) => (c[1] as string[])[1] === "get_app_container"
      );
      expect(probed, action).toBe(false);
    }
  });

  it("granting location on a shutdown simulator surfaces the boot hint, not a false 'not installed'", async () => {
    // get_app_container needs a booted sim: on a shutdown sim it fails with
    // "Unable to lookup in current state: Shutdown" for installed AND missing
    // apps alike, so the install guard must NOT read that as "not installed".
    // It must fall through to the privacy grant, which fails the same way and
    // gets the boot hint. Regression guard: a blanket catch→false previously
    // mislabeled an installed app as uninstalled on a shutdown sim and steered
    // the agent to reinstall instead of boot.
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
        cb(
          Object.assign(new Error("Unable to lookup in current state: Shutdown"), {
            code: 149,
          })
        );
      }
    );
    const rejection = expect(
      iosImpl.handler({}, params({ action: "grant", permission: "location" }), iosDevice)
    ).rejects;
    await rejection.toThrow(/must be booted first — use boot-device/);
    await rejection.not.toThrow(/the app is not installed/);
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
      "pm list packages 'com.example.app'",
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

  it("reset still counts a revoked permission whose flags could not be cleared", async () => {
    // clear-permission-flags is best-effort: it first appears in Android 13
    // (API 33) and can't undo the revoke, so its failure must NOT demote a
    // permission the revoke already changed. Revoke succeeded here -> applied,
    // not skipped, no error (previously this reported a misleading total failure).
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm clear-permission-flags")) {
        throw new Error("pm clear-permission-flags exited with code 255");
      }
      return undefined;
    });
    const result = await androidImpl.handler({}, params({ action: "reset" }), androidDevice);
    expect(result.applied).toEqual(["android.permission.CAMERA"]);
    expect(result.skipped).toBeUndefined();
  });

  it("a transport-level adb failure at the preflight is rethrown, not mislabeled as not-installed", async () => {
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm list packages")) {
        throw new Error("adb: device 'emulator-5554' not found");
      }
      return undefined;
    });
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toThrow(/device 'emulator-5554' not found/);
    await rejection.not.toThrow(/not installed/);
  });

  it("a slow/unavailable package manager at the preflight is rethrown, not mislabeled as not-installed", async () => {
    // `pm list packages` exits 0 for a missing package, so any THROW here is a
    // real failure (timeout/kill, or pm not up yet right after boot) — it must
    // surface the real cause, not "not installed" (the old `pm path` probe's bug).
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm list packages")) {
        throw new Error("Could not access the Package Manager. Is the system running?");
      }
      return undefined;
    });
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toThrow(/Could not access the Package Manager/);
    await rejection.not.toThrow(/not installed/);
  });

  it("a package pm cannot resolve fails with not-found instead of a silent success", async () => {
    // `pm list packages <pkg>` exits 0 with NO output for a missing package
    // (verified on API 36), so the handler detects the absent `package:` line
    // and never issues a grant/revoke (which would exit 0 for a missing package).
    mockAdbShell.mockImplementation(async (_serial, cmd) => {
      if (cmd.startsWith("pm list packages")) return "";
      return "";
    });
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED)
    );
    const commands = mockAdbShell.mock.calls.map((c) => c[1]);
    expect(commands).toEqual(["pm list packages 'com.example.app'"]);
  });

  it("does not treat a substring package match as installed", async () => {
    // `pm list packages` filters by substring, so a request for `com.example.app`
    // can return only `com.example.app.helper`; the exact-line check must reject
    // that rather than operate on the wrong package.
    mockAdbShell.mockImplementation(async (_serial, cmd) => {
      if (cmd.startsWith("pm list packages")) return "package:com.example.app.helper";
      return "";
    });
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED)
    );
  });

  it("finds the target package among substring siblings", async () => {
    // The realistic installed shape: `pm list packages <pkg>` filters by
    // substring, so an installed app usually returns several lines — the target
    // plus every package whose name contains it (e.g. `com.google.android.gms`
    // returns both `...gms.supervision` and `...gms`). The per-line `.some(...)`
    // must match the exact target line among the siblings, in any order; a switch
    // to whole-output or first-line matching would read a real installed app as
    // "not installed" while every other Android test stayed green.
    mockAdbShell.mockImplementation(async (_serial, cmd) => {
      if (cmd.startsWith("pm list packages")) {
        return "package:com.example.app.helper\npackage:com.example.app\npackage:com.example.app.debug";
      }
      return "";
    });
    const result = await androidImpl.handler({}, params({}), androidDevice);
    expect(result.applied).toEqual(["android.permission.CAMERA"]);
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      "pm grant 'com.example.app' android.permission.CAMERA",
      expect.anything()
    );
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

  it("maps each abstract permission to its concrete android.permission.* set", async () => {
    // Lock the ANDROID_PERMISSIONS table: camera/photos/location(-always) are
    // covered above, this pins the rest so an accidental emptying/typo of a
    // mapping surfaces here instead of silently granting the wrong permission or
    // reporting "unsupported". Notably notifications→POST_NOTIFICATIONS (a
    // primary Android use case) and the two-permission contacts/calendar/
    // media-library fan-outs, none of which had a mapping assertion.
    const cases: Array<[SettingsPermissionsParams["permission"], string[]]> = [
      ["microphone", ["android.permission.RECORD_AUDIO"]],
      ["contacts", ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"]],
      ["notifications", ["android.permission.POST_NOTIFICATIONS"]],
      ["calendar", ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"]],
      [
        "media-library",
        ["android.permission.READ_MEDIA_AUDIO", "android.permission.READ_EXTERNAL_STORAGE"],
      ],
      ["motion", ["android.permission.ACTIVITY_RECOGNITION"]],
    ];
    for (const [permission, expected] of cases) {
      const result = await androidImpl.handler({}, params({ permission }), androidDevice);
      expect(result.applied, permission).toEqual(expected);
    }
  });

  it("partial pm failures (a real device throws on exit 255) land in `skipped`, not an error", async () => {
    // photos → READ_MEDIA_IMAGES ok, READ_MEDIA_VIDEO ok, READ_EXTERNAL_STORAGE
    // rejected. On a real device (verified on API 34) `pm grant` for a
    // non-changeable permission exits 255 and writes the SecurityException to
    // stderr, so adbShell THROWS and the failure is handled in runPm's catch
    // branch (not the exit-0 stdout inspection). Exercise that realistic path.
    adbDefaults((cmd) => {
      if (cmd.includes("READ_EXTERNAL_STORAGE")) {
        throw new Error(
          "adb -s emulator-5554 shell pm grant 'com.example.app' android.permission.READ_EXTERNAL_STORAGE failed: " +
            "java.lang.SecurityException: Permission android.permission.READ_EXTERNAL_STORAGE requested by com.example.app is not a changeable permission type\n" +
            "\tat com.android.server.pm.permission.PermissionManagerServiceImpl.grantRuntimePermissionInternal(PermissionManagerServiceImpl.java:1423)"
        );
      }
      return undefined;
    });
    const result = await androidImpl.handler({}, params({ permission: "photos" }), androidDevice);
    expect(result.applied).toEqual([
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    ]);
    expect(result.skipped).toEqual(["android.permission.READ_EXTERNAL_STORAGE"]);
  });

  it("photos includes READ_MEDIA_VISUAL_USER_SELECTED so partial-access is cleared", async () => {
    // On API 34+ the platform auto-adds USER_SELECTED alongside READ_MEDIA_*, and
    // the partial-access dialog grants it persistently. Omitting it would let
    // `deny photos` leave the app passing its partial-access check. Pin that the
    // mapping fans out to it (pre-34 devices reject it → it lands in `skipped`).
    const result = await androidImpl.handler(
      {},
      params({ action: "deny", permission: "photos" }),
      androidDevice
    );
    expect(result.applied).toContain("android.permission.READ_MEDIA_VISUAL_USER_SELECTED");
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      "pm revoke 'com.example.app' android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      expect.anything()
    );
  });

  it("pm rejecting every mapped permission (thrown on exit 255) raises the failure and strips Java stack frames", async () => {
    // The realistic API 34+ path: pm exits 255, adbShell throws, and the message
    // (built from adb's stderr) carries the exception plus its Java stack frames.
    // runPm's catch branch runs stripStackFrames on the THROWN err.message.
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm grant")) {
        throw new Error(
          "adb -s emulator-5554 shell pm grant 'com.example.app' android.permission.CAMERA failed: " +
            "java.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA\n" +
            "\tat com.android.server.pm.permission.PermissionManagerServiceImpl.grantRuntimePermissionInternal(PermissionManagerServiceImpl.java:1423)\n" +
            "\tat android.os.Binder.execTransact(Binder.java:1275)"
        );
      }
      return undefined;
    });
    const rejection = expect(androidImpl.handler({}, params({}), androidDevice)).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED));
    await rejection.toSatisfy(
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("has not requested permission") &&
        !err.message.includes("at com.android.server") &&
        !err.message.includes("at android.os.Binder")
    );
  });

  it("pm reporting a failure as exit-0 stdout is still treated as a failure", async () => {
    // Some pm builds print the SecurityException to stdout and exit 0; runPm's
    // stdout inspection must still classify a non-`Success` output as a failure.
    adbDefaults((cmd) =>
      cmd.startsWith("pm grant")
        ? "Exception occurred while executing 'grant':\njava.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA"
        : undefined
    );
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

  it("a device dropping mid-fan-out propagates the transport error, not a `skipped` entry", async () => {
    // If the device disconnects after one permission already applied, the
    // remaining pm calls are not manifest rejections — the transport is dead.
    // The handler must surface adb's real cause (a terminal "device not found"),
    // not return success with the dead-device permissions in `skipped`.
    adbDefaults((cmd) => {
      if (cmd.includes("READ_MEDIA_VIDEO"))
        throw new Error("adb: device 'emulator-5554' not found");
      return undefined;
    });
    const rejection = expect(
      androidImpl.handler({}, params({ permission: "photos" }), androidDevice)
    ).rejects;
    await rejection.toThrow(/device 'emulator-5554' not found/);
    await rejection.not.toThrow(/every mapped runtime permission was rejected/);
  });

  it("a timed-out pm call propagates the classified FailureError with its telemetry intact", async () => {
    // adbShell classifies a killed/timed-out call as a FailureError with
    // error_kind "timeout" + subprocess metadata. A wedged device must keep that
    // classification, not be relabelled as a generic manifest failure — the iOS
    // branch forwards the same metadata, and sibling Android tools propagate it.
    const timeoutErr = new FailureError("pm grant ... (killed=true signal=SIGKILL)", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
    adbDefaults((cmd) => {
      if (cmd.startsWith("pm grant")) throw timeoutErr;
      return undefined;
    });
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      (err: unknown) => err === timeoutErr && getFailureSignal(err)?.error_kind === "timeout"
    );
  });

  it("resetting location-always touches only the background permission (not fine/coarse)", async () => {
    // The grant→foreground fan-out is grant-only: a reset must not also revoke
    // ACCESS_FINE/COARSE_LOCATION ("taking away 'always' shouldn't strip 'while
    // in use'"). Pins that the fan-out condition stays `action === "grant"` — a
    // loosening to `action !== "deny"` would revoke fine+coarse here.
    await androidImpl.handler(
      {},
      params({ action: "reset", permission: "location-always" }),
      androidDevice
    );
    const commands = mockAdbShell.mock.calls.map((c) => c[1]);
    expect(commands).toEqual([
      "pm list packages 'com.example.app'",
      "pm revoke 'com.example.app' android.permission.ACCESS_BACKGROUND_LOCATION",
      "pm clear-permission-flags 'com.example.app' android.permission.ACCESS_BACKGROUND_LOCATION user-set user-fixed",
    ]);
  });
});

describe("settings-permissions dispatch wiring (through tool.execute)", () => {
  // The per-branch tests above call iosImpl/androidImpl directly, so they can't
  // catch a mis-wired dispatch table (e.g. `ios: androidImpl, android: iosImpl`,
  // which typechecks and would run `pm` against iOS UDIDs). These drive the real
  // `execute` with shaped udids and assert each platform reaches its OWN binary
  // — xcrun for iOS, adb for Android, sim-remote for ios-remote — so any swap of
  // the branches fails here. Dep cache is primed so `ensureDeps` doesn't shell
  // out to `command -v` and perturb `execFileMock` call counts.
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb", "sim-remote"]);
  });

  it("an iOS udid runs `xcrun simctl privacy`, never adb", async () => {
    execFileSucceeds();
    const result = await settingsPermissionsTool.execute(
      {},
      { udid: IOS_UDID, action: "grant", permission: "microphone", bundleId: "com.example.app" }
    );
    expect(result.applied).toEqual(["microphone"]);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect((args as string[]).slice(0, 2)).toEqual(["simctl", "privacy"]);
    expect(mockAdbShell).not.toHaveBeenCalled();
  });

  it("an Android serial runs `pm` over adb, never xcrun", async () => {
    // Give execFile a resolving impl so an accidental ios/android swap fails via
    // a clean assertion (wrong `applied` shape) instead of hanging on an
    // unconfigured mock that never invokes its callback.
    execFileSucceeds();
    const result = await settingsPermissionsTool.execute(
      {},
      { udid: ANDROID_SERIAL, action: "grant", permission: "camera", bundleId: "com.example.app" }
    );
    expect(result.applied).toEqual(["android.permission.CAMERA"]);
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      "pm grant 'com.example.app' android.permission.CAMERA",
      expect.anything()
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a `remote:` udid routes to the ios-remote branch (sim-remote)", async () => {
    // The ios-remote branch + appleRemote capability let a sim-remote setup
    // pre-set permissions, matching the launch-app / open-url family. sim-remote
    // shells out via the same execFile, so assert the `sim-remote` invocation.
    execFileSucceeds();
    const result = await settingsPermissionsTool.execute(
      {},
      {
        udid: `remote:${IOS_UDID}`,
        action: "grant",
        permission: "microphone",
        bundleId: "com.example.app",
      }
    );
    expect(result.applied).toEqual(["microphone"]);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("sim-remote");
    expect((args as string[]).slice(0, 2)).toEqual(["simctl", "privacy"]);
    expect(mockAdbShell).not.toHaveBeenCalled();
  });
});

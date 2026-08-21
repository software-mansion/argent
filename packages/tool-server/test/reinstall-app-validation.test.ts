import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runAdb = vi.fn(async (..._a: unknown[]) => ({ stdout: "Success", stderr: "" }));
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));

// ios.ts builds its runner with promisify(execFile) at module load, so mock
// the callback-style child_process entry rather than promisify itself —
// mocking promisify globally breaks every other module that uses it.
const execFileCalls: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (cmd: string, args: string[], cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push([cmd, ...args]);
    cb(null, { stdout: "", stderr: "" });
  },
}));

const vegaDevice = vi.fn(async (..._a: unknown[]) => ({ stdout: "Success", stderr: "" }));
vi.mock("../src/utils/vega-cli", () => ({ vegaDevice: (...a: unknown[]) => vegaDevice(...a) }));

const simctlUninstall = vi.fn(async (..._a: unknown[]) => {});
const simctlInstall = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../src/utils/sim-remote", () => ({
  simctlUninstall: (...a: unknown[]) => simctlUninstall(...a),
  simctlInstall: (...a: unknown[]) => simctlInstall(...a),
}));

import { androidImpl } from "../src/tools/reinstall-app/platforms/android";
import { iosImpl } from "../src/tools/reinstall-app/platforms/ios";
import { iosRemoteImpl } from "../src/tools/reinstall-app/platforms/ios-remote";
import { vegaImpl } from "../src/tools/reinstall-app/platforms/vega";

const TMP = mkdtempSync(join(tmpdir(), "argent-reinstall-validation-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** An existing file that is not an installable artifact — the reported case. */
const NOT_AN_ARTIFACT = join(TMP, "notes.txt");
writeFileSync(NOT_AN_ARTIFACT, "definitely not an app");

/** Named .apk but not a zip: a truncated or half-written build output. */
const FAKE_APK = join(TMP, "app.apk");
writeFileSync(FAKE_APK, "not a zip archive");

/** A directory that only looks like an iOS bundle. */
const EMPTY_APP = join(TMP, "Empty.app");
mkdirSync(EMPTY_APP, { recursive: true });

const MISSING = join(TMP, "nope", "Missing.app");

beforeEach(() => {
  runAdb.mockClear();
  execFileCalls.length = 0;
  vegaDevice.mockClear();
  simctlUninstall.mockClear();
  simctlInstall.mockClear();
});

function params(appPath: string) {
  return { udid: "device-1", bundleId: "com.example.app", appPath } as never;
}

// The handlers ignore device/options; a stub satisfies the arity.
const DEVICE = { platform: "ios", udid: "device-1" } as never;

/**
 * The whole point of the fix: a rejected artifact must not have cost the user
 * their installation. `reinstall-app` uninstalls unconditionally and takes the
 * app's data with it, so "did we reach the uninstall" is the assertion that
 * matters — not merely "did it throw".
 */
describe("reinstall-app rejects a bad artifact before uninstalling anything", () => {
  it("android: an existing file that is not an .apk", async () => {
    await expect(androidImpl.handler({} as never, params(NOT_AN_ARTIFACT), DEVICE)).rejects.toThrow(
      /not an \.apk/
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("android: an .apk that is not a zip archive", async () => {
    await expect(androidImpl.handler({} as never, params(FAKE_APK), DEVICE)).rejects.toThrow(
      /not a zip archive/
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("android: a path that does not exist", async () => {
    await expect(androidImpl.handler({} as never, params(MISSING), DEVICE)).rejects.toThrow(
      /does not exist/
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("ios: a file where a .app bundle directory was expected", async () => {
    await expect(iosImpl.handler({} as never, params(NOT_AN_ARTIFACT), DEVICE)).rejects.toThrow(
      /is a file, but an iOS app bundle is a directory/
    );
    expect(execFileCalls).toHaveLength(0);
  });

  it("ios: a .app directory with no Info.plist", async () => {
    await expect(iosImpl.handler({} as never, params(EMPTY_APP), DEVICE)).rejects.toThrow(
      /Info\.plist/
    );
    expect(execFileCalls).toHaveLength(0);
  });

  it("ios-remote: same structural checks, no device round trip", async () => {
    await expect(
      iosRemoteImpl.handler({} as never, params(NOT_AN_ARTIFACT), DEVICE)
    ).rejects.toThrow(/iOS app bundle is a directory/);
    expect(simctlUninstall).not.toHaveBeenCalled();
    expect(simctlInstall).not.toHaveBeenCalled();
  });

  it("vega: an artifact that is not a .vpkg", async () => {
    await expect(vegaImpl.handler({} as never, params(NOT_AN_ARTIFACT), DEVICE)).rejects.toThrow(
      /not a \.vpkg/
    );
    // One mock serves both uninstall-app and install-app, so check the verb.
    const verbs = vegaDevice.mock.calls.map((c) => (c as unknown[])[1]);
    expect(verbs).toHaveLength(0);
  });

  it("says the installation was left alone, so the caller knows the device is intact", async () => {
    const err = await androidImpl
      .handler({} as never, params(NOT_AN_ARTIFACT), DEVICE)
      .catch((e: Error) => e);
    expect(String(err)).toContain("existing installation was left untouched");
  });
});

describe("reinstall-app still installs a good artifact", () => {
  it("android: accepts a real zip-backed .apk and reaches adb", async () => {
    const realApk = join(TMP, "real.apk");
    // PK\x03\x04 — the local file header every APK starts with.
    writeFileSync(realApk, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

    await expect(androidImpl.handler({} as never, params(realApk), DEVICE)).resolves.toMatchObject({
      reinstalled: true,
    });
    expect(runAdb).toHaveBeenCalled();
  });

  it("android: accepts an uppercase extension, because adb does", async () => {
    // Verified against adb: `UPPER.APK` installs fine. Being stricter than adb
    // would reject artifacts that work today.
    const upper = join(TMP, "UPPER.APK");
    writeFileSync(upper, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    await expect(androidImpl.handler({} as never, params(upper), DEVICE)).resolves.toMatchObject({
      reinstalled: true,
    });
  });

  it("android: a first-time install is unaffected when the uninstall fails", async () => {
    // The uninstall is swallowed on purpose — nothing may be installed yet.
    const realApk = join(TMP, "first.apk");
    writeFileSync(realApk, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    runAdb.mockImplementationOnce(async () => {
      throw new Error("Failure [DELETE_FAILED_INTERNAL_ERROR]");
    });

    await expect(androidImpl.handler({} as never, params(realApk), DEVICE)).resolves.toMatchObject({
      reinstalled: true,
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// plutil (bundle id) and xcrun (uninstall/install) both go through execFile;
// CI runs on Linux, so neither is real here.
const execFileCalls: { cmd: string; args: string[] }[] = [];
let plistBundleId = "";
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    execFileCalls.push({ cmd, args });
    if (cmd === "plutil") {
      if (plistBundleId) cb(null, { stdout: `${plistBundleId}\n`, stderr: "" });
      else cb(new Error("No value at that key path"));
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
  },
}));
vi.mock("../src/utils/ios-device-sets", () => ({
  simctlTargetForUdid: async (udid: string) => ({ nativeId: udid, prefix: ["simctl"] }),
}));
const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));

import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";
import { parseManifestPackage, readApkPackageName } from "../src/utils/apk-package";
import { iosImpl } from "../src/tools/reinstall-app/platforms/ios";
import { androidImpl } from "../src/tools/reinstall-app/platforms/android";

/** Binary AndroidManifest.xml: `<manifest package="…">` with the given string-pool encoding. */
function axml(pkg: string, utf8 = false): Buffer {
  const strings = ["package", "manifest", pkg];
  const encoded = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    const head = Buffer.alloc(2);
    head.writeUInt16LE(s.length);
    return Buffer.concat([head, Buffer.from(s, "utf16le"), Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let off = 0;
  encoded.forEach((e, i) => {
    offsets.writeUInt32LE(off, i * 4);
    off += e.length;
  });
  const data = Buffer.concat(encoded);
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const poolHeader = Buffer.alloc(28);
  poolHeader.writeUInt16LE(0x0001, 0);
  poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(28 + offsets.length + padded.length, 4);
  poolHeader.writeUInt32LE(strings.length, 8);
  poolHeader.writeUInt32LE(utf8 ? 1 << 8 : 0, 16);
  poolHeader.writeUInt32LE(28 + offsets.length, 20);
  const pool = Buffer.concat([poolHeader, offsets, padded]);

  const element = Buffer.alloc(36 + 20);
  element.writeUInt16LE(0x0102, 0);
  element.writeUInt16LE(16, 2);
  element.writeUInt32LE(element.length, 4);
  element.writeUInt32LE(0xffffffff, 16); // ns
  element.writeUInt32LE(1, 20); // name: "manifest"
  element.writeUInt16LE(20, 24); // attributeStart
  element.writeUInt16LE(20, 26); // attributeSize
  element.writeUInt16LE(1, 28); // attributeCount
  element.writeUInt32LE(0xffffffff, 36); // attr ns
  element.writeUInt32LE(0, 40); // attr name: "package"
  element.writeUInt32LE(2, 44); // attr raw value

  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + pool.length + element.length, 4);
  return Buffer.concat([header, pool, element]);
}

/** Single-entry zip; deflated unless `stored`. */
function zip(name: string, content: Buffer, stored = false): Buffer {
  const data = stored ? content : deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(stored ? 0 : 8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(stored ? 0 : 8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const dirOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

const DEVICE = {} as DeviceInfo;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reinstall-validate-"));
  execFileCalls.length = 0;
  plistBundleId = "";
  runAdb.mockReset().mockResolvedValue({ stdout: "Success", stderr: "" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readApkPackageName", () => {
  it("reads the package from a deflated UTF-16 manifest and a stored UTF-8 one", async () => {
    writeFileSync(join(dir, "a.apk"), zip("AndroidManifest.xml", axml("com.example.app")));
    writeFileSync(join(dir, "b.apk"), zip("AndroidManifest.xml", axml("com.ex.b", true), true));
    await expect(readApkPackageName(join(dir, "a.apk"))).resolves.toBe("com.example.app");
    await expect(readApkPackageName(join(dir, "b.apk"))).resolves.toBe("com.ex.b");
  });

  it("rejects a non-zip and a zip without a manifest", async () => {
    writeFileSync(join(dir, "x.apk"), "not a zip");
    writeFileSync(join(dir, "y.apk"), zip("classes.dex", Buffer.from("dex")));
    await expect(readApkPackageName(join(dir, "x.apk"))).rejects.toThrow(/not a zip/);
    await expect(readApkPackageName(join(dir, "y.apk"))).rejects.toThrow(/no AndroidManifest/);
    expect(() => parseManifestPackage(Buffer.alloc(8))).toThrow(/no package attribute/);
  });
});

describe("reinstall-app android: validates before uninstalling", () => {
  const params = (appPath: string, bundleId = "com.example.app") => ({
    udid: "emulator-5554",
    bundleId,
    appPath,
  });

  it("rejects a missing APK without running adb", async () => {
    const err = await androidImpl
      .handler({}, params(join(dir, "nope.apk")), DEVICE)
      .catch((e) => e);
    expect(err.message).toMatch(/does not exist\. Nothing was uninstalled/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("rejects a package that does not match the APK without running adb", async () => {
    const apk = join(dir, "app.apk");
    writeFileSync(apk, zip("AndroidManifest.xml", axml("com.example.app")));
    await expect(androidImpl.handler({}, params(apk, "com.other"), DEVICE)).rejects.toThrow(
      /com\.other does not match .* which is com\.example\.app/
    );
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("uninstalls and installs when the package matches", async () => {
    const apk = join(dir, "app.apk");
    writeFileSync(apk, zip("AndroidManifest.xml", axml("com.example.app")));
    await expect(androidImpl.handler({}, params(apk), DEVICE)).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(runAdb.mock.calls.map(([args]) => (args as string[])[2])).toEqual([
      "uninstall",
      "install",
    ]);
  });
});

describe("reinstall-app ios: validates before uninstalling", () => {
  const params = (appPath: string, bundleId = "com.example.App") => ({
    udid: "SIM-UDID",
    bundleId,
    appPath,
  });
  const xcrunCalls = () => execFileCalls.filter((c) => c.cmd === "xcrun");
  const makeApp = (withPlist = true) => {
    const app = join(dir, "My.app");
    mkdirSync(app);
    if (withPlist) writeFileSync(join(app, "Info.plist"), "<plist/>");
    return app;
  };

  it("rejects a missing .app without running simctl", async () => {
    await expect(iosImpl.handler({}, params(join(dir, "Gone.app")), DEVICE)).rejects.toThrow(
      /does not exist\. Nothing was uninstalled/
    );
    expect(xcrunCalls()).toEqual([]);
  });

  it("rejects a directory with no Info.plist without running simctl", async () => {
    await expect(iosImpl.handler({}, params(makeApp(false)), DEVICE)).rejects.toThrow(
      /no Info\.plist/
    );
    expect(xcrunCalls()).toEqual([]);
  });

  it("rejects a bundle id that does not match the .app without running simctl", async () => {
    plistBundleId = "com.example.Other";
    await expect(iosImpl.handler({}, params(makeApp()), DEVICE)).rejects.toThrow(
      /com\.example\.App does not match .* which is com\.example\.Other/
    );
    expect(xcrunCalls()).toEqual([]);
  });

  it("rejects a bundle id that differs only in case: simctl would uninstall nothing", async () => {
    plistBundleId = "com.example.app";
    await expect(iosImpl.handler({}, params(makeApp()), DEVICE)).rejects.toThrow(/does not match/);
    expect(xcrunCalls()).toEqual([]);
  });

  it("uninstalls and installs when the bundle id matches", async () => {
    plistBundleId = "com.example.App";
    await expect(iosImpl.handler({}, params(makeApp()), DEVICE)).resolves.toMatchObject({
      reinstalled: true,
    });
    expect(xcrunCalls().map((c) => c.args[1])).toEqual(["uninstall", "install"]);
  });
});

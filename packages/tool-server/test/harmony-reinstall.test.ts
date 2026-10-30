import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
const runHdc = vi.fn();
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdc: (...a: unknown[]) => runHdc(...a),
}));

import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { harmonyImpl } from "../src/tools/reinstall-app/platforms/harmony";

// Output measured on the HarmonyOS 6.1.1 emulator; `hdc` exits 0 for all of it.
const OUT = {
  installed: "[Info]App install path:/x.hap msg:install bundle successfully. \nAppMod finish\n",
  uninstalled: "[Info]App uninstall path: msg:uninstall bundle successfully. \nAppMod finish\n",
  notInstalled:
    "[Info]App uninstall path: msg:error: failed to uninstall bundle. code:9568386 error: uninstall missing installed bundle. \nAppMod finish\n",
  parseFailed:
    "[Info]App install path:/x.hap msg:error: failed to install bundle. code:9568337 error: install parse unexpected. \nAppMod finish\n",
  unreachable: "[Fail]ExecuteCommand need connect-key? please confirm a device by help info\n",
};

/** Single-entry deflated zip. */
function zip(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

const DEVICE = { id: "harmony-127.0.0.1:5555", platform: "harmony", kind: "device" } as DeviceInfo;
const BUNDLE = "com.example.hello";
let dir: string;

function hap(moduleJson: unknown, name = "app.hap"): string {
  const path = join(dir, name);
  writeFileSync(path, zip("module.json", Buffer.from(JSON.stringify(moduleJson))));
  return path;
}
const run = (appPath: string, bundleId = BUNDLE) =>
  harmonyImpl.handler({}, { udid: DEVICE.id, bundleId, appPath }, DEVICE);
const hdcSteps = () => runHdc.mock.calls.map(([args]) => (args as string[]).slice(0, 3));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harmony-reinstall-"));
  runHdc.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reinstall-app harmony: validates the .hap before uninstalling", () => {
  it("rejects a missing file, a non-zip, a hap without a bundle name, and a mismatch, running no hdc", async () => {
    writeFileSync(join(dir, "text.hap"), "not a zip");
    const cases: Array<[string, RegExp]> = [
      [join(dir, "gone.hap"), /does not exist\. Nothing was uninstalled/],
      [join(dir, "text.hap"), /is not a readable HAP \(not a zip archive\)/],
      [hap({ module: { name: "entry" } }, "nameless.hap"), /no app\.bundleName in module\.json/],
      [
        hap({ app: { bundleName: "com.other" } }),
        /com\.example\.hello does not match .* which is com\.other/,
      ],
    ];
    for (const [path, message] of cases) {
      const err = await run(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(message);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    }
    expect(runHdc).not.toHaveBeenCalled();
  });
});

describe("reinstall-app harmony: uninstall then install", () => {
  it("uninstalls the bundle and installs the hap on the device's connect key", async () => {
    const path = hap({ app: { bundleName: BUNDLE } });
    runHdc
      .mockResolvedValueOnce({ stdout: OUT.uninstalled, stderr: "" })
      .mockResolvedValueOnce({ stdout: OUT.installed, stderr: "" });

    await expect(run(path)).resolves.toEqual({ reinstalled: true, bundleId: BUNDLE });
    expect(runHdc.mock.calls.map(([args]) => args)).toEqual([
      ["-t", "127.0.0.1:5555", "uninstall", BUNDLE],
      ["-t", "127.0.0.1:5555", "install", path],
    ]);
  });

  it("installs when the bundle was not installed", async () => {
    const path = hap({ app: { bundleName: BUNDLE } });
    runHdc
      .mockResolvedValueOnce({ stdout: OUT.notInstalled, stderr: "" })
      .mockResolvedValueOnce({ stdout: OUT.installed, stderr: "" });

    await expect(run(path)).resolves.toEqual({ reinstalled: true, bundleId: BUNDLE });
    expect(hdcSteps().map((s) => s[2])).toEqual(["uninstall", "install"]);
  });

  it("stops before installing when the uninstall fails for another reason", async () => {
    const path = hap({ app: { bundleName: BUNDLE } });
    runHdc.mockResolvedValueOnce({ stdout: OUT.unreachable, stderr: "" });

    const err = await run(path).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `hdc uninstall of '${BUNDLE}' failed on HarmonyOS device '127.0.0.1:5555': ` +
        "[Fail]ExecuteCommand need connect-key? please confirm a device by help info"
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_REINSTALL_FAILED);
    expect(hdcSteps().map((s) => s[2])).toEqual(["uninstall"]);
  });

  it("fails with the device's own message when the install is refused", async () => {
    const path = hap({ app: { bundleName: BUNDLE } });
    runHdc
      .mockResolvedValueOnce({ stdout: OUT.uninstalled, stderr: "" })
      .mockResolvedValueOnce({ stdout: OUT.parseFailed, stderr: "" });

    const err = await run(path).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `hdc install of '${BUNDLE}' failed on HarmonyOS device '127.0.0.1:5555': ` +
        "error: failed to install bundle. code:9568337 error: install parse unexpected."
    );
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.HARMONY_REINSTALL_FAILED,
      failure_stage: "harmony_reinstall_install",
    });
  });
});

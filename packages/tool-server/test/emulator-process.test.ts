import { describe, it, expect, afterEach } from "vitest";
import { listEmulatorPidsForAvd, parseEmulatorPidsForAvd } from "../src/utils/emulator-process";

const QEMU_MAC =
  "/Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_7 -no-snapshot-save -gpu auto";
const QEMU_LINUX =
  "/home/me/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd Pixel_7 -no-snapshot-load";
const LAUNCHER = "/Users/me/Library/Android/sdk/emulator/emulator -avd Pixel_7";
const VVD =
  "/Users/me/vega/sdk/vvd/images/tv/vmtools/agent/qemu/darwin-aarch64/vega-virtual-device -avd-arch arm64 -ports 5554,5555";

const ps = (...rows: Array<[number, string]>) =>
  rows.map(([pid, cmd]) => `${pid} ${cmd}`).join("\n");

describe("parseEmulatorPidsForAvd", () => {
  it("finds the qemu process running the AVD on macOS and Linux paths, and the launcher", () => {
    const out = ps([101, QEMU_MAC], [102, QEMU_LINUX], [103, LAUNCHER], [1, "/sbin/launchd"]);
    expect(parseEmulatorPidsForAvd(out, "Pixel_7")).toEqual([101, 102, 103]);
  });

  it("matches -avd <name> as a whole argument only", () => {
    const out = ps(
      [201, QEMU_MAC.replace("-avd Pixel_7 ", "-avd Pixel_7_API_34 ")],
      [202, QEMU_MAC.replace("-avd Pixel_7 ", "-avd My_Pixel_7 ")],
      [203, QEMU_MAC]
    );
    expect(parseEmulatorPidsForAvd(out, "Pixel_7")).toEqual([203]);
    expect(parseEmulatorPidsForAvd(out, "Pixel_7_API_34")).toEqual([201]);
  });

  it("treats regex characters in the AVD name literally", () => {
    const out = ps([301, QEMU_MAC.replace("-avd Pixel_7 ", "-avd Pixel.7 ")], [302, QEMU_MAC]);
    expect(parseEmulatorPidsForAvd(out, "Pixel.7")).toEqual([301]);
    expect(parseEmulatorPidsForAvd(out, "Pixel_7")).toEqual([302]);
  });

  it("ignores processes that only mention the AVD or are not an emulator", () => {
    const out = ps(
      [401, VVD],
      [402, "grep -avd Pixel_7"],
      [403, "/bin/zsh -c emulator -avd Pixel_7"],
      [404, "node /tmp/repro.mjs qemu-system-aarch64 -avd Pixel_7"]
    );
    expect(parseEmulatorPidsForAvd(out, "Pixel_7")).toEqual([]);
  });

  it("returns empty for empty output", () => {
    expect(parseEmulatorPidsForAvd("", "Pixel_7")).toEqual([]);
  });
});

describe("listEmulatorPidsForAvd", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("reports nothing on Windows, where there is no ps", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(await listEmulatorPidsForAvd("Pixel_7")).toEqual([]);
  });

  it.skipIf(originalPlatform === "win32")(
    "reads the live process table without error",
    async () => {
      // No emulator with this name can be running; the point is that ps runs and parses.
      expect(await listEmulatorPidsForAvd("argent_no_such_avd_for_tests")).toEqual([]);
    }
  );
});

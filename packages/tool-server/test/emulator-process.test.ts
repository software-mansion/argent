import { describe, it, expect, afterEach } from "vitest";
import {
  isDescendantOf,
  listEmulatorPidsForAvd,
  parseParentPids,
  parseEmulatorPidsForAvd,
  parseEmulatorProcessesForAvd,
  parseProcNetTcpListeners,
} from "../src/utils/emulator-process";

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

  it("finds an emulator launched as `emulator @<avd>`, as a whole argument only", () => {
    // The launcher execs into qemu with the `@<avd>` argument unchanged.
    const short = (avd: string) =>
      `/Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless @${avd} -read-only -no-window`;
    const out = ps([601, short("Pixel_7")], [602, short("Pixel_7_API_34")]);
    expect(parseEmulatorPidsForAvd(out, "Pixel_7")).toEqual([601]);
    expect(parseEmulatorProcessesForAvd(out, "Pixel_7_API_34")).toEqual([
      { pid: 602, readOnly: true, port: null },
    ]);
  });
});

describe("isDescendantOf", () => {
  const parents = parseParentPids("  700     1\n  701   700\n  702   701\n  800     1\n");

  it("follows the process tree up from a pid", () => {
    expect(isDescendantOf(700, 700, parents)).toBe(true);
    expect(isDescendantOf(702, 700, parents)).toBe(true);
    expect(isDescendantOf(800, 700, parents)).toBe(false);
    expect(isDescendantOf(999, 700, parents)).toBe(false);
  });

  it("stops on a cycle", () => {
    expect(
      isDescendantOf(
        1,
        2,
        new Map([
          [3, 4],
          [4, 3],
        ])
      )
    ).toBe(false);
    expect(
      isDescendantOf(
        3,
        2,
        new Map([
          [3, 4],
          [4, 3],
        ])
      )
    ).toBe(false);
  });
});

describe("parseEmulatorProcessesForAvd", () => {
  it("reads -read-only and -port as whole arguments", () => {
    const out = ps(
      [501, `${QEMU_MAC} -read-only -port 5584`],
      [502, QEMU_MAC.replace("-avd Pixel_7 ", "-avd Pixel_7 -read-only ")],
      [503, `${QEMU_MAC} -port 5560`],
      [504, `${QEMU_MAC} -read-only-ish -portal 5590`]
    );
    expect(parseEmulatorProcessesForAvd(out, "Pixel_7")).toEqual([
      { pid: 501, readOnly: true, port: 5584 },
      { pid: 502, readOnly: true, port: null },
      { pid: 503, readOnly: false, port: 5560 },
      { pid: 504, readOnly: false, port: null },
    ]);
  });
});

describe("parseProcNetTcpListeners", () => {
  // /proc/net/tcp with an emulator console on 127.0.0.1:5554 (0x15B2), a
  // connection from it, and a listener on another port.
  const TCP = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:15B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:15B2 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1",
    "   2: 0100007F:15B4 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41300 1 0000000000000000 100 0 0 10 0",
  ].join("\n");

  it("returns the inodes of the sockets listening on the port, not its connections", () => {
    expect(parseProcNetTcpListeners(TCP, 5554)).toEqual(["41234"]);
    expect(parseProcNetTcpListeners(TCP, 5558)).toEqual([]);
  });

  it("reads the IPv6 table's longer addresses", () => {
    const tcp6 =
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 00000000000000000000000001000000:15B2 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52001 1 0000000000000000 100 0 0 10 0";
    expect(parseProcNetTcpListeners(tcp6, 5554)).toEqual(["52001"]);
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

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { listAndroidDevices, listAvds } from "../src/utils/adb";

beforeEach(() => {
  execFileMock.mockReset();
});

describe("readAvdName — modern property, legacy fallback (review #3)", () => {
  /**
   * Emulator release 30 (Android 11+) moved the AVD name from
   * `ro.kernel.qemu.avd_name` to `ro.boot.qemu.avd_name`. Reading only the
   * old property makes modern images report `avdName: null`, which in turn
   * breaks `findSerialByAvdName` disambiguation when two emulators boot
   * concurrently.
   *
   * The fix probes the new prop first and falls back to the old one. These
   * tests pin both paths.
   */

  function mockAdbGetProps(
    serial: string,
    props: Partial<{
      "ro.product.model": string;
      "ro.build.version.sdk": string;
      "ro.boot.qemu.avd_name": string;
      "ro.kernel.qemu.avd_name": string;
    }>
  ): void {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "devices" && args.length === 1) {
        return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shell = args[3] ?? "";
        for (const [prop, value] of Object.entries(props)) {
          if (shell === `getprop ${prop}`) return { stdout: `${value}\n`, stderr: "" };
        }
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("reads ro.boot.qemu.avd_name on modern images (Android 11+)", async () => {
    mockAdbGetProps("emulator-5554", {
      "ro.product.model": "sdk_gphone64",
      "ro.build.version.sdk": "34",
      "ro.boot.qemu.avd_name": "Pixel_7_API_34",
      "ro.kernel.qemu.avd_name": "",
    });

    const devices = await listAndroidDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.avdName).toBe("Pixel_7_API_34");
  });

  it("falls back to ro.kernel.qemu.avd_name on legacy images", async () => {
    mockAdbGetProps("emulator-5554", {
      "ro.product.model": "sdk_gphone",
      "ro.build.version.sdk": "29",
      "ro.boot.qemu.avd_name": "",
      "ro.kernel.qemu.avd_name": "Pixel_3a_API_29",
    });

    const devices = await listAndroidDevices();
    expect(devices[0]!.avdName).toBe("Pixel_3a_API_29");
  });

  it("prefers the modern property when both are present (some images double-set)", async () => {
    mockAdbGetProps("emulator-5554", {
      "ro.product.model": "sdk_gphone64",
      "ro.build.version.sdk": "34",
      "ro.boot.qemu.avd_name": "Pixel_7_API_34",
      "ro.kernel.qemu.avd_name": "Pixel_7_API_34_stale",
    });

    const devices = await listAndroidDevices();
    expect(devices[0]!.avdName).toBe("Pixel_7_API_34");
  });

  it("returns null when neither property is set (physical device)", async () => {
    mockAdbGetProps("R5CT12345678", {
      "ro.product.model": "SM-G990B",
      "ro.build.version.sdk": "33",
    });
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: `List of devices attached\nR5CT12345678\tdevice\n`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shell = args[3] ?? "";
        if (shell === "getprop ro.product.model") return { stdout: "SM-G990B\n", stderr: "" };
        if (shell === "getprop ro.build.version.sdk") return { stdout: "33\n", stderr: "" };
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const devices = await listAndroidDevices();
    expect(devices[0]!.avdName).toBeNull();
  });
});

describe("listAvds noise filter (review #9)", () => {
  /**
   * Old filter was prefix-only — any AVD name starting with INFO/HAX was
   * silently dropped. Real `emulator -list-avds` noise is diagnostic
   * header/footer lines that contain whitespace or colons (e.g.
   * `INFO    | Android emulator version ...`), while AVD names are
   * identifier-only. The new filter accepts identifier-shaped lines only.
   */

  it("accepts an AVD name that happens to start with HAX (e.g. HAX-Pixel-6)", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "emulator") {
        return { stdout: "HAX-Pixel-6\nINFO_BuildBot_Pixel7\nPixel_7_API_34\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const avds = await listAvds();
    expect(avds.map((a) => a.name)).toEqual([
      "HAX-Pixel-6",
      "INFO_BuildBot_Pixel7",
      "Pixel_7_API_34",
    ]);
  });

  it("filters out genuine noise lines with whitespace / pipe characters", async () => {
    // Real emulator output on at least some installs prints a log-format header.
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "emulator") {
        return {
          stdout: [
            "INFO    | Android emulator version 33.1.11.0",
            "HAX is working and emulator runs in fast virt mode.",
            "Pixel_7_API_34",
            "Pixel_3a_API_29",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const avds = await listAvds();
    expect(avds.map((a) => a.name)).toEqual(["Pixel_7_API_34", "Pixel_3a_API_29"]);
  });
});

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { activeIosDeviceSetPath, defaultIosDeviceSetPath, simctlArgs } from "../src/utils/simctl";

describe("simctl device-set helpers", () => {
  it("uses plain simctl args when no custom device set is configured", () => {
    expect(simctlArgs(["list", "devices"], {})).toEqual(["simctl", "list", "devices"]);
  });

  it("injects --set with a normalized custom device set path", () => {
    expect(
      simctlArgs(["list", "devices"], { ARGENT_IOS_DEVICE_SET_PATH: "tmp/device-set" })
    ).toEqual(["simctl", "--set", path.resolve("tmp/device-set"), "list", "devices"]);
  });

  it("exposes the default device set path when no custom set is configured", () => {
    expect(defaultIosDeviceSetPath()).toBe(
      path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices")
    );
    expect(activeIosDeviceSetPath({})).toBe(defaultIosDeviceSetPath());
  });
});

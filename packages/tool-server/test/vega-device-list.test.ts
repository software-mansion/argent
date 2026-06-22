import { describe, it, expect } from "vitest";
import { parseVegaDeviceList } from "../src/utils/vega-devices";

describe("parseVegaDeviceList", () => {
  it("parses the standard VirtualDevice row (serial is the trailing token)", () => {
    const out = parseVegaDeviceList(
      "Found the following device:\nVirtualDevice : tv - aarch64 - OS - amazon-4a27df03c9777152\n"
    );
    expect(out).toEqual([{ type: "VirtualDevice", serial: "amazon-4a27df03c9777152" }]);
  });

  it("skips adb-transport rows that appear after `adb connect` to the VVD", () => {
    // When adb is explicitly connected, the CLI lists the device in adb form.
    // We drive Vega via the device-type serial only, so these rows are ignored
    // (and the `host:port` colon must not be mistaken for the ` : ` separator).
    const out = parseVegaDeviceList(
      "Found the following devices:\n" +
        "127.0.0.1:5555 : AN4ZFZ17D377Y\n" +
        "emulator-5554 : AN4ZFZ17D377Y\n"
    );
    expect(out).toEqual([]);
  });

  it("ignores the banner line", () => {
    expect(parseVegaDeviceList("Found the following device:\n")).toEqual([]);
  });
});

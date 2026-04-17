import { describe, it, expect } from "vitest";
import { parseAdbDevices } from "../src/utils/adb";

describe("parseAdbDevices", () => {
  it("parses a typical `adb devices` output", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "R5CT12345678\tdevice",
      "",
    ].join("\n");
    expect(parseAdbDevices(stdout)).toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "R5CT12345678", state: "device" },
    ]);
  });

  it("includes offline and unauthorized devices with their state", () => {
    const stdout = ["List of devices attached", "emulator-5554\toffline", "abc\tunauthorized"].join(
      "\n"
    );
    expect(parseAdbDevices(stdout)).toEqual([
      { serial: "emulator-5554", state: "offline" },
      { serial: "abc", state: "unauthorized" },
    ]);
  });

  it("ignores blank lines and the header only", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });

  it("tolerates `-l` suffix metadata after state", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64",
    ].join("\n");
    expect(parseAdbDevices(stdout)).toEqual([{ serial: "emulator-5554", state: "device" }]);
  });
});

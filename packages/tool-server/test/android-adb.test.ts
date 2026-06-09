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

  it("skips the daemon-startup banner adb prints when its background server is cold", () => {
    // Real output when the adb server isn't running yet — without a guard,
    // the loose `\S+ \s+ \S+` regex parses these as devices and the boot loop
    // adopts a phantom serial.
    const stdout = [
      "* daemon not running; starting now at tcp:5037 *",
      "* daemon started successfully *",
      "List of devices attached",
      "emulator-5554\tdevice",
    ].join("\n");
    expect(parseAdbDevices(stdout)).toEqual([{ serial: "emulator-5554", state: "device" }]);
  });

  it("ignores lines whose state is not a known adb state", () => {
    // Defensive: anything that isn't in the canonical adb state set must not
    // become a phantom device. Catches future adb versions adding garbage
    // fields and protects against a subtly-malformed banner the * filter misses.
    const stdout = ["List of devices attached", "emulator-5554\tdevice", "junk\tnotastate"].join(
      "\n"
    );
    expect(parseAdbDevices(stdout)).toEqual([{ serial: "emulator-5554", state: "device" }]);
  });
});

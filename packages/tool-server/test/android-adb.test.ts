import { describe, it, expect } from "vitest";
import { parseAdbDevices, consolePortFromAdbSerial } from "../src/utils/adb";

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

describe("consolePortFromAdbSerial", () => {
  it("maps an emulator serial to its console port", () => {
    expect(consolePortFromAdbSerial("emulator-5554")).toBe(5554);
    expect(consolePortFromAdbSerial("emulator-5556")).toBe(5556);
  });

  it("maps a loopback adb-connect serial to the console port (adb port - 1)", () => {
    expect(consolePortFromAdbSerial("127.0.0.1:5555")).toBe(5554);
    expect(consolePortFromAdbSerial("localhost:5555")).toBe(5554);
    expect(consolePortFromAdbSerial("::1:5555")).toBe(5554);
  });

  it("returns null for a wireless physical device on a non-loopback host", () => {
    // Must not be mistaken for an emulator/VVD shadow.
    expect(consolePortFromAdbSerial("192.168.1.5:5555")).toBeNull();
  });

  it("returns null for a bare hardware serial or malformed input", () => {
    expect(consolePortFromAdbSerial("R5CT12345678")).toBeNull();
    expect(consolePortFromAdbSerial("emulator-abc")).toBeNull();
  });
});

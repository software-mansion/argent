import { describe, it, expect, beforeEach, vi } from "vitest";
import { deviceNameMatcher } from "../../src/utils/debugger/device-name";

const { listIosSimulators, adbShell, runAdb } = vi.hoisted(() => ({
  listIosSimulators: vi.fn(),
  adbShell: vi.fn(),
  runAdb: vi.fn(),
}));

vi.mock("../../src/utils/ios-devices", () => ({ listIosSimulators }));
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/adb")>()),
  adbShell,
  runAdb,
}));

const A = "B7D5711C-0000-4000-8000-00000000000A";
const B = "B7D5711C-0000-4000-8000-00000000000B";
const C = "B7D5711C-0000-4000-8000-00000000000C";
const sim = (udid: string, name: string, state = "Booted") => ({
  udid,
  name,
  state,
  runtime: "iOS-26-5",
});

/** `adb devices` lists `serials`; each answers the model|release|sdk getprop from `props`. */
function adbWith(props: Record<string, string | Error>) {
  runAdb.mockResolvedValue({
    stdout:
      "List of devices attached\n" +
      Object.keys(props)
        .map((serial) => `${serial}\tdevice`)
        .join("\n") +
      "\n",
    stderr: "",
  });
  adbShell.mockImplementation(async (serial: string) => {
    const answer = props[serial];
    if (answer instanceof Error) throw answer;
    return `${answer}\n`;
  });
}

describe("deviceNameMatcher", () => {
  beforeEach(() => {
    listIosSimulators.mockReset();
    adbShell.mockReset();
    runAdb.mockReset();
  });

  describe("on an iOS simulator", () => {
    it("matches the simulator's exact name", async () => {
      listIosSimulators.mockResolvedValue([sim(A, "iPhone 17 [ink-and-quill]"), sim(B, "Pixel")]);
      const matches = await deviceNameMatcher(A);
      expect(matches?.("iPhone 17 [ink-and-quill]")).toBe(true);
      expect(matches?.("iPhone 17")).toBe(false);
    });

    it("gives no matcher when another booted simulator has the same name", async () => {
      listIosSimulators.mockResolvedValue([sim(A, "Twin 2036"), sim(B, "Twin 2036"), sim(C, "kb")]);
      expect(await deviceNameMatcher(A)).toBeUndefined();
    });

    it("ignores a simulator of the same name that is not booted", async () => {
      listIosSimulators.mockResolvedValue([
        sim(A, "iPhone 17 Pro"),
        sim(B, "iPhone 17 Pro", "Shutdown"),
      ]);
      expect((await deviceNameMatcher(A))?.("iPhone 17 Pro")).toBe(true);
    });

    it("gives no matcher for a simulator that is not booted or not found", async () => {
      listIosSimulators.mockResolvedValue([sim(A, "Solo", "Shutdown")]);
      expect(await deviceNameMatcher(A)).toBeUndefined();
      expect(await deviceNameMatcher(B)).toBeUndefined();
    });

    // React Native sends the name unescaped in a query string: Metro lists
    // `Dev&QA` as `Dev` and `Pro+Max` as `Pro Max`.
    it.each(["Dev&QA", "Pro+Max"])("gives no matcher for a simulator named %s", async (name) => {
      listIosSimulators.mockResolvedValue([sim(A, name)]);
      expect(await deviceNameMatcher(A)).toBeUndefined();
    });

    it.each([
      ["Dev&QA", "Dev"],
      ["Pro+Max", "Pro Max"],
    ])("counts another booted simulator, %s, under the name %s", async (other, listed) => {
      listIosSimulators.mockResolvedValue([sim(A, listed), sim(B, other)]);
      expect(await deviceNameMatcher(A)).toBeUndefined();
    });
  });

  describe("on Android", () => {
    it("matches the friendly name React Native reports, and the bare model", async () => {
      adbWith({ "emulator-5554": "sdk_gphone64_arm64|16|36" });
      const matches = await deviceNameMatcher("emulator-5554");
      expect(matches?.("sdk_gphone64_arm64 - 16 - API 36")).toBe(true);
      expect(matches?.("sdk_gphone64_arm64")).toBe(true);
      expect(matches?.("sdk_gphone64_arm64 - 15 - API 35")).toBe(false);
    });

    it("tells same-model emulators apart by release and API level", async () => {
      adbWith({
        "emulator-5554": "sdk_gphone64_arm64|16|36",
        "emulator-5556": "sdk_gphone64_arm64|15|35",
      });
      const matches = await deviceNameMatcher("emulator-5554");
      expect(matches?.("sdk_gphone64_arm64 - 16 - API 36")).toBe(true);
      // A bare model would fit either device.
      expect(matches?.("sdk_gphone64_arm64")).toBe(false);
      expect(matches?.("sdk_gphone64_arm64 - 15 - API 35")).toBe(false);
    });

    it("gives no matcher when another device reports the same name", async () => {
      adbWith({
        "emulator-5554": "sdk_gphone64_arm64|16|36",
        "emulator-5556": "sdk_gphone64_arm64|16|36",
      });
      expect(await deviceNameMatcher("emulator-5554")).toBeUndefined();
    });

    it("gives no matcher when another device does not answer", async () => {
      adbWith({
        "emulator-5554": "sdk_gphone64_arm64|16|36",
        "emulator-5556": new Error("device offline"),
      });
      expect(await deviceNameMatcher("emulator-5554")).toBeUndefined();
    });

    it("gives no matcher when the device itself does not answer", async () => {
      adbWith({ "emulator-5554": new Error("device offline") });
      expect(await deviceNameMatcher("emulator-5554")).toBeUndefined();
    });
  });

  it("gives no matcher for ids that carry no usable name", async () => {
    expect(await deviceNameMatcher("chromium-cdp-9222")).toBeUndefined();
    expect(await deviceNameMatcher("00008110-001A2B3C4D5E801E")).toBeUndefined();
    expect(listIosSimulators).not.toHaveBeenCalled();
    expect(adbShell).not.toHaveBeenCalled();
  });
});

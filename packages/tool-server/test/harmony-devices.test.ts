import { describe, it, expect, vi, beforeEach } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import {
  HARMONY_LIST_TIMEOUT_MS,
  HDC_LIST_TIMEOUT_MS,
  listHarmonyHdcTargets,
  listHarmonyInstances,
  parseHarmonyInstances,
  parseHdcTargets,
} from "../src/utils/harmony-devices";
import { runHarmonyEmulator as realRunHarmonyEmulator } from "../src/utils/harmony-cli";
import { runHdc as realRunHdc } from "../src/utils/harmony-hdc";

vi.mock("../src/utils/harmony-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-cli")>()),
  resolveHarmonyEmulator: vi.fn(async () => "/deveco/Emulator"),
  runHarmonyEmulator: vi.fn(async () => ({ stdout: "[Empty]", stderr: "" })),
}));
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  resolveHdc: vi.fn(async () => "/deveco/hdc"),
  runHdc: vi.fn(async () => ({ stdout: "[Empty]", stderr: "" })),
}));
import {
  HARMONY_EMULATOR_ID_PREFIX,
  HARMONY_ID_PREFIX,
  classifyDevice,
  harmonyConnectKey,
  harmonyDeviceId,
  harmonyEmulatorId,
  harmonyInstanceName,
  resolveDevice,
} from "../src/utils/device-info";

/** Fixtures are verbatim stdout from DevEco Studio 6.1's `Emulator` and `hdc` 3.2.0d on macOS. */

/** `Emulator -list -details` with nothing deployed. */
const EMULATOR_NO_INSTANCES = "[Empty]\n";

/** Printed per broken instance directory, ahead of the JSON body. */
const EMULATOR_CONFIG_NOT_FOUND =
  'Config file not found: "/Users/u/.Huawei/Emulator/deployed/zz_broken/config.ini"\n';

const EMULATOR_ONE_INSTANCE = `[
    {
        "deviceName": "argent_probe",
        "deviceType": "Phone",
        "hw.hdc.port": "10000",
        "hw.lcd.single.height": "2856",
        "hw.lcd.single.width": "1320",
        "isRunning": "false",
        "name": "argent_probe",
        "os.apiVersion": "24",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    }
]
`;

const EMULATOR_TWO_INSTANCES = `[
    {
        "deviceName": "argent_probe",
        "deviceType": "Phone",
        "isRunning": "false",
        "name": "argent_probe",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    },
    {
        "deviceName": "argent_probe2",
        "deviceType": "TV",
        "isRunning": "true",
        "name": "argent_probe2",
        "os.osVersion": "HarmonyOS 6.1.1(24)"
    }
]
`;

/** `hdc list targets -v` with one phone attached; the second column is empty. */
const HDC_ONE_DEVICE = "025DEK236V035771\t\tUSB\tConnected\tlocalhost\n";

/** `hdc list targets` (and `-v`) with nothing attached. */
const HDC_NO_DEVICES = "[Empty]\n";

describe("parseHarmonyInstances", () => {
  it("returns no instances for the empty sentinel", () => {
    expect(parseHarmonyInstances(EMULATOR_NO_INSTANCES)).toEqual([]);
  });

  it("reads name, form factor, OS version, running state and panel", () => {
    expect(parseHarmonyInstances(EMULATOR_ONE_INSTANCE)).toEqual([
      {
        name: "argent_probe",
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: { width: 1320, height: 2856 },
      },
    ]);
  });

  it("reads the panel as numbers, from the strings the manager emits", () => {
    const [one] = parseHarmonyInstances(EMULATOR_ONE_INSTANCE);
    expect(one.display).toEqual({ width: 1320, height: 2856 });
  });

  it("reports no panel rather than a broken one when the config does not describe a single LCD", () => {
    const partial = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": "1320" }]`;
    const zeroed = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": "0", "hw.lcd.single.height": "2856" }]`;
    const absent = `[{ "name": "n", "isRunning": "false" }]`;
    for (const raw of [partial, zeroed, absent]) {
      expect(parseHarmonyInstances(raw)[0].display).toBeNull();
    }
  });

  it("reports no panel rather than the digits it could read off the front of one", () => {
    // `parseInt("1,320")` is 1, a panel no guest reports.
    const shapes = ["1,320", "1e4", "1320px", "1320\n2856", "999999999999999999999"];
    for (const width of shapes) {
      const raw = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": ${JSON.stringify(
        width
      )}, "hw.lcd.single.height": "2856" }]`;
      expect(parseHarmonyInstances(raw)[0].display).toBeNull();
    }
  });

  it("reads isRunning as the string it actually is, not a JSON boolean", () => {
    const [, tv] = parseHarmonyInstances(EMULATOR_TWO_INSTANCES);
    expect(tv.running).toBe(true);
  });

  it("keeps the instances listed after a config diagnostic", () => {
    expect(
      parseHarmonyInstances(`${EMULATOR_CONFIG_NOT_FOUND}${EMULATOR_ONE_INSTANCE}`).map(
        (i) => i.name
      )
    ).toEqual(["argent_probe"]);
  });

  it("keeps them when that diagnostic quotes a path containing a bracket", () => {
    // The prose names a user-chosen directory, which may contain `[`.
    const bracketed =
      'Config file not found: "/Users/u/.Huawei/Emulator/deployed/zz[1]/config.ini"\n';
    expect(
      parseHarmonyInstances(`${bracketed}${EMULATOR_ONE_INSTANCE}`).map((i) => i.name)
    ).toEqual(["argent_probe"]);
  });

  it("returns both instances when two are deployed", () => {
    expect(parseHarmonyInstances(EMULATOR_TWO_INSTANCES).map((i) => i.name)).toEqual([
      "argent_probe",
      "argent_probe2",
    ]);
  });

  it("returns no instances rather than throwing on unparseable output", () => {
    expect(parseHarmonyInstances("[ this is not json")).toEqual([]);
    expect(parseHarmonyInstances("some future banner line\n")).toEqual([]);
  });
});

describe("parseHdcTargets", () => {
  it("returns no targets for the empty sentinel", () => {
    expect(parseHdcTargets(HDC_NO_DEVICES)).toEqual([]);
  });

  it("reads the connect key, transport and state past the empty second column", () => {
    expect(parseHdcTargets(HDC_ONE_DEVICE)).toEqual([
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);
  });

  it("does not read a one-word line as a connected target", () => {
    expect(parseHdcTargets("Timeout\n")).toEqual([]);
    expect(parseHdcTargets("025DEK236V035771\n")).toEqual([]);
  });

  it("reports a non-connected target's real state", () => {
    // Verbatim from `hdc tconn` against nothing listening: the row precedes the handshake.
    const row = parseHdcTargets("127.0.0.1:12399\t\tTCP\tOffline\tunknown...\n")[0];
    expect(row).toEqual({ connectKey: "127.0.0.1:12399", connection: "TCP", state: "Offline" });
  });
});

describe("HarmonyOS device ids", () => {
  it("classifies both harmony id forms as harmony", () => {
    expect(classifyDevice("harmony-025DEK236V035771")).toBe("harmony");
    expect(classifyDevice("harmony-emulator-Phone_1")).toBe("harmony");
  });

  it("does not classify an id without the prefix as harmony", () => {
    expect(classifyDevice("Phone_1")).toBe("android");
    expect(classifyDevice("my-harmony-Phone_1")).toBe("android");
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });

  it("resolves an emulator id to kind emulator and a target id to kind device", () => {
    expect(resolveDevice("harmony-emulator-Phone_1").kind).toBe("emulator");
    expect(resolveDevice("harmony-025DEK236V035771").kind).toBe("device");
  });

  it("round-trips an instance name and a connect key through their ids", () => {
    expect(harmonyEmulatorId("Phone_1")).toBe(`${HARMONY_EMULATOR_ID_PREFIX}Phone_1`);
    expect(harmonyInstanceName(harmonyEmulatorId("Phone_1"))).toBe("Phone_1");
    expect(harmonyDeviceId("025DEK236V035771")).toBe(`${HARMONY_ID_PREFIX}025DEK236V035771`);
    expect(harmonyConnectKey(harmonyDeviceId("025DEK236V035771"))).toBe("025DEK236V035771");
  });

  it("round-trips an instance whose own name looks like the emulator marker", () => {
    expect(harmonyInstanceName(harmonyEmulatorId("emulator-1"))).toBe("emulator-1");
  });

  it("leaves an unprefixed name alone", () => {
    expect(harmonyInstanceName("Phone_1")).toBe("Phone_1");
    expect(harmonyConnectKey("025DEK236V035771")).toBe("025DEK236V035771");
  });

  it("refuses an instance id rather than driving the key that stripping it invents", () => {
    // The capability gate does not cover flow steps.
    expect(() => harmonyConnectKey(harmonyEmulatorId("Phone_1"))).toThrow(
      /names a HarmonyOS emulator instance/
    );
  });
});

// A 30s wrapper default would outlive list-devices' branch deadline.
describe("discovery calls are bounded by the constants list-devices was sized against", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bounds `Emulator -list -details`", async () => {
    await listHarmonyInstances();
    expect(vi.mocked(realRunHarmonyEmulator)).toHaveBeenCalledWith(
      ["-list", "-details"],
      HARMONY_LIST_TIMEOUT_MS
    );
  });

  it("bounds `hdc list targets`", async () => {
    await listHarmonyHdcTargets();
    expect(vi.mocked(realRunHdc)).toHaveBeenCalledWith(
      ["list", "targets", "-v"],
      HDC_LIST_TIMEOUT_MS
    );
  });

  it("hands a caller's own ceiling to `Emulator`, not just the default", async () => {
    await listHarmonyInstances(1_500);
    expect(vi.mocked(realRunHarmonyEmulator)).toHaveBeenCalledWith(["-list", "-details"], 1_500);
  });

  it("hands a caller's own ceiling to `hdc`, not just the default", async () => {
    await listHarmonyHdcTargets(1_500);
    expect(vi.mocked(realRunHdc)).toHaveBeenCalledWith(["list", "targets", "-v"], 1_500);
  });
});

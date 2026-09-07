import { describe, it, expect, vi, beforeEach } from "vitest";
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

/**
 * Fixtures are verbatim stdout from DevEco Studio 6.1's `Emulator` manager
 * (6.1.1.200) and from `hdc` 3.2.0d talking to a physical HarmonyOS 6.0.1
 * handset, both on macOS.
 */

/** `Emulator -list -details` with nothing deployed. */
const EMULATOR_NO_INSTANCES = "[Empty]\n";

/**
 * Printed once per directory under ~/.Huawei/Emulator/deployed/ that lacks a
 * config.ini — ahead of the JSON body, which is why the parser scans forward to
 * the body's own line-leading bracket instead of parsing from byte zero.
 */
const EMULATOR_CONFIG_NOT_FOUND =
  'Config file not found: "/Users/u/.Huawei/Emulator/deployed/zz_broken/config.ini"\n';

/** One instance, abridged to the keys the parser reads plus a few it ignores. */
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

/** `hdc list targets -v` with one phone attached. Note the empty second column. */
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
    // `boot-device` compares this against the `render resolution` the booted
    // guest reports — measured identical on a 6.1.1 phone image — to tell its own
    // instance from another device that reconnected beside it. Left as the
    // manager's strings it would never equal anything.
    const [one] = parseHarmonyInstances(EMULATOR_ONE_INSTANCE);
    expect(one.display).toEqual({ width: 1320, height: 2856 });
  });

  it("reports no panel rather than a broken one when the config does not describe a single LCD", () => {
    // A multi-display profile keys its LCDs differently, so the keys can be
    // absent on a perfectly good instance. `boot-device` skips the panel check
    // entirely for a null, which is why a partial or zero reading must not
    // masquerade as a measurement.
    const partial = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": "1320" }]`;
    const zeroed = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": "0", "hw.lcd.single.height": "2856" }]`;
    const absent = `[{ "name": "n", "isRunning": "false" }]`;
    for (const raw of [partial, zeroed, absent]) {
      expect(parseHarmonyInstances(raw)[0].display).toBeNull();
    }
  });

  it("reports no panel rather than the digits it could read off the front of one", () => {
    // A truncated read is the dangerous shape: `parseInt("1,320")` is 1, a
    // panel no guest can ever report back, so `boot-device` would spend the
    // whole budget concluding the instance it started is another device. Worse
    // than the null, which only turns the check off.
    const shapes = ["1,320", "1e4", "1320px", "1320\n2856", "999999999999999999999"];
    for (const width of shapes) {
      const raw = `[{ "name": "n", "isRunning": "false", "hw.lcd.single.width": ${JSON.stringify(
        width
      )}, "hw.lcd.single.height": "2856" }]`;
      expect(parseHarmonyInstances(raw)[0].display).toBeNull();
    }
  });

  it("reads isRunning as the string it actually is, not a JSON boolean", () => {
    // The manager emits every value as a string, `isRunning` included. Comparing
    // it as a boolean would make every instance read as stopped, so a booted
    // emulator would be reported as needing a boot.
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
    // The prose names an instance DIRECTORY, so its content is whatever the
    // user called the folder. Scanning to the first `[` anywhere would start
    // the slice inside the sentence, and the parse failure that follows reads
    // to `boot-device` as a host with no instances at all — so a boot of a
    // perfectly good instance is refused because a sibling folder is misnamed.
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
    // `-v` leaves column 2 blank, so splitting on single tabs would shift every
    // field one left and report this connected phone's state as "USB" — a value
    // no readiness check matches, hiding a healthy device from the device list.
    expect(parseHdcTargets(HDC_ONE_DEVICE)).toEqual([
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);
  });

  it("does not read a one-word line as a connected target", () => {
    // The two prose checks above turn on a line holding a space, so a one-word
    // diagnostic passed both and was emitted as `{ state: "Connected" }`: a
    // target that does not exist for the boot's arrival wait to adopt, and —
    // since a parsed row means "a listing was printed" — the diagnostic itself
    // swallowed instead of reported. Every real row is tab-separated, which is
    // what `-v` buys and why the listing always passes it.
    expect(parseHdcTargets("Timeout\n")).toEqual([]);
    expect(parseHdcTargets("025DEK236V035771\n")).toEqual([]);
  });

  it("reports a non-connected target's real state", () => {
    // Verbatim from `hdc tconn 127.0.0.1:12399` against nothing listening: the
    // target is registered and listed before any handshake succeeds. So a TCP
    // row is the shape a booted emulator takes, and `Offline` is a state it can
    // genuinely be found in — which is why the boot path waits for `Connected`
    // rather than for the row to exist.
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
    // The bare instance name and a name that merely contains "harmony" are an
    // Android serial by shape — only the leading prefix routes to HarmonyOS.
    expect(classifyDevice("Phone_1")).toBe("android");
    expect(classifyDevice("my-harmony-Phone_1")).toBe("android");
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });

  it("resolves an emulator id to kind emulator and a target id to kind device", () => {
    // The two are driven by different CLIs — `Emulator -start` boots an instance,
    // `uitest` over hdc drives a connected target — so the kind decides which
    // tools accept the id at all.
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
    // One prefix stripped, not a greedy match: an instance a user named
    // `emulator-1` must not come back as `1` and boot the wrong instance.
    expect(harmonyInstanceName(harmonyEmulatorId("emulator-1"))).toBe("emulator-1");
  });

  it("leaves an unprefixed name alone", () => {
    expect(harmonyInstanceName("Phone_1")).toBe("Phone_1");
    expect(harmonyConnectKey("025DEK236V035771")).toBe("025DEK236V035771");
  });

  it("refuses an instance id rather than driving the key that stripping it invents", () => {
    // `harmony-emulator-Phone_1` carries the target prefix too, so a slice
    // yields `emulator-Phone_1` — a key no target holds. The capability gate
    // stops an instance id at the HTTP edge, but a flow step goes through the
    // registry, which does not gate it, and `hdc` would answer for a device the
    // caller never named.
    expect(() => harmonyConnectKey(harmonyEmulatorId("Phone_1"))).toThrow(
      /names a HarmonyOS emulator instance/
    );
  });
});

// Both wrappers default to 30s, which is itself above `list-devices`'
// BRANCH_DEADLINE_MS — so a discovery call that forgets to pass its own timeout
// is not merely slower, it is a branch the backstop truncates while it is still
// working, dropping every HarmonyOS device from the list. The deadline test
// compares the two constants; this is what ties them to the calls.
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

  // The caller's ceiling has to reach the process, not just the argument list.
  // A `timeoutMs` accepted and dropped here leaves `boot-device`'s clamp
  // computing a bound nothing enforces — and the callers that pass one are
  // polling to a deadline, so the ceiling they hand over is the whole point.
  it("hands a caller's own ceiling to `Emulator`, not just the default", async () => {
    await listHarmonyInstances(1_500);
    expect(vi.mocked(realRunHarmonyEmulator)).toHaveBeenCalledWith(["-list", "-details"], 1_500);
  });

  it("hands a caller's own ceiling to `hdc`, not just the default", async () => {
    await listHarmonyHdcTargets(1_500);
    expect(vi.mocked(realRunHdc)).toHaveBeenCalledWith(["list", "targets", "-v"], 1_500);
  });
});

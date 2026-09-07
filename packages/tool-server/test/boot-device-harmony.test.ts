import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal, type Registry } from "@argent/registry";

const runHarmonyEmulator = vi.fn();
const resolveHarmonyEmulator = vi.fn();
const listHarmonyInstances = vi.fn();
const listHarmonyHdcTargets = vi.fn();
const listHarmonyHdcTargetsStrict = vi.fn();
const resolveHdc = vi.fn();
const ensureDep = vi.fn();
const spawnMock = vi.fn();
const harmonyDisplay = vi.fn();
const harmonyDumpLayout = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});
vi.mock("../src/utils/harmony-cli", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-cli")>(
    "../src/utils/harmony-cli"
  );
  return {
    ...actual,
    runHarmonyEmulator: (...a: unknown[]) => runHarmonyEmulator(...a),
    resolveHarmonyEmulator: (...a: unknown[]) => resolveHarmonyEmulator(...a),
  };
});
vi.mock("../src/utils/harmony-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-devices")>(
    "../src/utils/harmony-devices"
  );
  return {
    ...actual,
    listHarmonyInstances: (...a: unknown[]) => listHarmonyInstances(...a),
    listHarmonyHdcTargets: (...a: unknown[]) => listHarmonyHdcTargets(...a),
    listHarmonyHdcTargetsStrict: (...a: unknown[]) => listHarmonyHdcTargetsStrict(...a),
  };
});
vi.mock("../src/utils/harmony-hdc", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-hdc")>(
    "../src/utils/harmony-hdc"
  );
  return { ...actual, resolveHdc: (...a: unknown[]) => resolveHdc(...a) };
});
vi.mock("../src/utils/harmony-uitest", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/harmony-uitest")>(
    "../src/utils/harmony-uitest"
  );
  return {
    ...actual,
    harmonyDisplay: (...a: unknown[]) => harmonyDisplay(...a),
    harmonyDumpLayout: (...a: unknown[]) => harmonyDumpLayout(...a),
  };
});
vi.mock("../src/utils/check-deps", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/check-deps")>("../src/utils/check-deps");
  return { ...actual, ensureDep: (...a: unknown[]) => ensureDep(...a) };
});

import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createDescribeTool } from "../src/tools/describe";
import { assertSupported } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

const registry = {} as Registry;
const INSTANCE = "Phone_1";
/** The USB phone from `hdc list targets -v`, present throughout. */
const PHONE = { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" };
/** What a booted emulator registers as, measured on a HarmonyOS 6.1.1 phone image. */
const EMULATOR_KEY = "127.0.0.1:5555";
const emulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Connected" };
/**
 * The row a stopped instance leaves behind. Measured: `-stop` takes the guest
 * down but never removes the row, so `127.0.0.1:5555  TCP  Offline  localhost`
 * survives in `hdc list targets -v` until the daemon is killed — and a restart
 * comes back on that same port.
 */
const staleEmulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Offline" };
/** A second emulator, already up and driveable when this boot starts. */
const foreignTarget = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Connected" };
/** `hw.lcd.single.width`/`height` of the phone image, echoed by the guest's `render resolution`. */
const PANEL = { width: 1320, height: 2856 };
/**
 * The start log is unique per boot attempt, so tests find it in the temp
 * directory rather than reconstructing its name. Sorted, so `.at(-1)` is the
 * newest attempt.
 */
function harmonyLogs(safeName: string): string[] {
  return readdirSync(tmpdir())
    .filter((f) => f.startsWith(`argent-harmony-${safeName}`) && f.endsWith(".log"))
    .sort();
}

function lastHarmonyLog(): string {
  const paths = harmonyLogs(INSTANCE);
  expect(paths.length, "no harmony start log was opened").toBeGreaterThan(0);
  return join(tmpdir(), paths.at(-1)!);
}
/** A second instance the manager keeps apart from {@link INSTANCE} by one space. */
const SPACED_INSTANCE = "Phone 1";
/** Its log prefix: the space escaped, since the name is not a safe filename as it stands. */
const SPACED_LOG_PREFIX = "argent-harmony-Phone%201";

/** Stands in for the detached `Emulator -start`, which normally never exits. */
class FakeEmulator extends EventEmitter {
  unref = vi.fn();
  /** The manager dying early, having printed `output` to its log. */
  die(output: string, code = 0) {
    writeFileSync(lastHarmonyLog(), output);
    this.emit("exit", code, null);
  }
}
let child: FakeEmulator;

function boot(params: Record<string, unknown>) {
  return createBootDeviceTool(registry).execute!({}, { harmonyInstance: INSTANCE, ...params });
}

/** A row of `hdc list targets -v`; `connection` is null without that flag. */
interface HdcTargetRow {
  connectKey: string;
  connection: string | null;
  state: string;
}

/** Successive `hdc list targets` results, the last one repeating forever. */
function targets(...rounds: HdcTargetRow[][]) {
  let call = 0;
  // One counter across both: the snapshot takes the first round and the polls
  // take the rest, exactly as when a single listing served both.
  const next = () => Promise.resolve(rounds[Math.min(call++, rounds.length - 1)]);
  listHarmonyHdcTargets.mockImplementation(next);
  listHarmonyHdcTargetsStrict.mockImplementation(next);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("argent-harmony-") && name.endsWith(".log")) {
      rmSync(join(tmpdir(), name), { force: true });
    }
  }
  child = new FakeEmulator();
  spawnMock.mockReturnValue(child);
  ensureDep.mockResolvedValue(undefined);
  resolveHarmonyEmulator.mockResolvedValue("/Applications/DevEco-Studio.app/.../Emulator");
  resolveHdc.mockResolvedValue("/Applications/DevEco-Studio.app/.../hdc");
  runHarmonyEmulator.mockResolvedValue({ stdout: "", stderr: "" });
  listHarmonyInstances.mockResolvedValue([
    {
      name: INSTANCE,
      deviceType: "Phone",
      osVersion: "HarmonyOS 6.1.1(24)",
      running: false,
      display: PANEL,
    },
  ]);
  // Every target answers with the instance's own panel unless a case says
  // otherwise, and every guest is driveable as soon as it is Connected.
  harmonyDisplay.mockResolvedValue({ ...PANEL, screenOn: true });
  harmonyDumpLayout.mockResolvedValue({ attributes: {} });
  targets([PHONE]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("boot-device — HarmonyOS emulator path", () => {
  it("returns the connect key of the target that appeared, not the instance id", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = await boot({});

    expect(ensureDep).toHaveBeenCalledWith("harmony-emulator");
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringContaining("Emulator"),
      ["-start", INSTANCE],
      expect.objectContaining({ detached: true })
    );
    expect(result).toEqual({
      platform: "harmony",
      udid: `harmony-${EMULATOR_KEY}`,
      instanceName: INSTANCE,
      booted: true,
    });
  });

  it("returns while the emulator is still running, rather than awaiting it", async () => {
    // `Emulator -start` is the emulator's supervisor and runs as long as it
    // does. Awaiting it spends the whole boot budget inside the start and then
    // kills the emulator when that budget expires, so the boot has to resolve
    // with the child still alive — which is what this test is, since `child`
    // never emits `exit`.
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(child.unref).toHaveBeenCalled();
  });

  it("ignores a target that was already connected before the start", async () => {
    // The phone is connected the whole time and must never be mistaken for the
    // instance just started — arrival is the only thing that identifies it.
    targets([PHONE], [PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("only counts a target once it is Connected", async () => {
    // A killed emulator leaves its row behind as `Offline` — measured — so a
    // row existing is not the same as a device there is any point driving. The
    // Offline row and the later Connected one are given DIFFERENT keys on
    // purpose: sharing one key would pass whether the code waited for
    // `Connected` or adopted the `Offline` row on the earlier poll, which is
    // exactly the drift this test exists to catch.
    const offlineOther = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Offline" };
    targets([PHONE], [PHONE, offlineOther], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("resolves the key an instance comes back on, though its row never left the listing", async () => {
    // The second boot of any instance this `hdc` daemon has already seen. Its
    // row is still listed — `Offline`, left there by the previous `-stop` — and
    // it re-registers on the same port, so a snapshot that kept every listed key
    // could never see it arrive: measured on the device as a full budget spent
    // and `harmony-emulator-argent_phone` handed back, an id no interaction tool
    // accepts, under a note blaming a boot that had in fact finished in seconds.
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("declines a fresh arrival whose panel is another device's", async () => {
    // `Offline` is also what a connection blip leaves behind, so a foreign
    // device reconnecting is an arrival by state alone. The instance's
    // configured panel is what separates the two: a wearable answers 466x466
    // where this phone image answers 1320x2856.
    const WEARABLE = { connectKey: "127.0.0.1:5561", connection: "TCP", state: "Connected" };
    harmonyDisplay.mockImplementation((key: string) =>
      Promise.resolve(
        key === WEARABLE.connectKey
          ? { width: 466, height: 466, screenOn: true }
          : { ...PANEL, screenOn: true }
      )
    );
    targets([PHONE], [PHONE, WEARABLE], [PHONE, WEARABLE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("matches the instance's panel whichever way round the guest composites it", async () => {
    // The manager reports the panel as configured, the guest as currently
    // oriented, so a landscape instance would read as a different device if the
    // axes were compared pairwise.
    harmonyDisplay.mockResolvedValue({ width: PANEL.height, height: PANEL.width, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("says a target was seen and declined rather than that none registered", async () => {
    // The panel filter's own failure mode. Blaming the budget would be the
    // wrong advice twice over: something did register, and a longer one cannot
    // change what it answered.
    const WEARABLE = { connectKey: "127.0.0.1:5561", connection: "TCP", state: "Connected" };
    harmonyDisplay.mockResolvedValue({ width: 466, height: 466, screenOn: true });
    targets([PHONE], [PHONE, WEARABLE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/not the panel this instance is configured with/);
    expect(result.note).not.toMatch(/bootTimeoutMs/);
  });

  it("leaves a target that cannot be probed yet pending rather than rejecting it", async () => {
    // A row reaches `Connected` before its render service answers. Treating an
    // unreadable probe as a mismatch would reject the instance permanently for
    // being early.
    let probes = 0;
    harmonyDisplay.mockImplementation(() =>
      probes++ < 2
        ? Promise.reject(new Error("[Fail][E001005] Device not found or connected"))
        : Promise.resolve({ ...PANEL, screenOn: true })
    );
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("does not adopt a cable-attached handset that arrives during the boot", async () => {
    // A second HarmonyOS target reaches Connected inside the boot window - a
    // phone plugged in or authorised mid-boot, or a still-settling row flipping
    // from Offline - while the emulator itself never registers. Arrival alone
    // cannot tell the two apart, so adopting the first new key hands back a
    // device this call did not boot.
    const OTHER = { connectKey: "BQR0223A14001199", connection: "USB", state: "Connected" };
    targets([PHONE], [PHONE, OTHER]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).not.toBe(`harmony-${OTHER.connectKey}`);
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toBeTruthy();
  });

  it("still adopts an arrival whose connection column is absent", async () => {
    // `hdc list targets` without `-v` prints the bare key, so `connection` is
    // null. Treating that as ineligible would refuse a boot that worked, on any
    // image or connector shape not seen here - so the USB exclusion has to fail
    // open rather than allow-list a single spelling.
    const UNTYPED = { connectKey: "127.0.0.1:5555", connection: null, state: "Connected" };
    targets([PHONE], [PHONE, UNTYPED]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses to guess when two targets it could have started both arrive", async () => {
    // A concurrent `boot-device` for a different instance is not coalesced -
    // `inFlightHarmonyBoots` keys on the instance name - so both emulators
    // register inside this call's window and arrival no longer picks one out.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    // Truthy is not enough: the note this branch returns must be the
    // two-arrival refusal, not the generic "had not registered before the boot
    // budget ran out" one — both targets DID register, and argent declined to
    // choose. Pointing the caller at `bootTimeoutMs` would misdiagnose it.
    expect(result.note).toMatch(/two|both|more than one|could not tell which/i);
  });

  it("refuses at once rather than spending the budget on a decision already made", async () => {
    // The refusal is settled the moment both are seen. Polling on would bill the
    // caller the whole 3-minute default for it — and would turn the refusal into
    // a guess if one of the two dropped out and left the other alone.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 180_000 });
    // Two polls' worth, three orders of magnitude short of the budget.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/More than one/);
  });

  it("keeps refusing after one of the two ambiguous targets drops away", async () => {
    // A still-settling emulator is the likelier of the two to flap, so the
    // survivor is the likelier to be the other device. Once both have been seen
    // the answer cannot be un-made by one leaving.
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR], [PHONE, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/More than one/);
  });

  it("waits for the guest to answer `uitest`, not merely for `hdc` to reach it", async () => {
    // A target reports `Connected` as soon as the daemon is reachable; the
    // window service comes up after it, and until it does every interaction tool
    // fails against an id that looks drivable.
    let probes = 0;
    harmonyDumpLayout.mockImplementation(() =>
      probes++ < 3
        ? Promise.reject(new Error("DumpLayout failed:Get window nodes failed"))
        : Promise.resolve({ attributes: {} })
    );
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(probes).toBeGreaterThan(3);
    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("still hands back the key when the guest never answers, and says so", async () => {
    // The key is the right id either way, so an unresponsive guest is a caveat
    // rather than a failure — but a silent one would put the caller's first
    // interaction failure down to the wrong cause.
    harmonyDumpLayout.mockRejectedValue(new Error("DumpLayout failed:Get window nodes failed"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/had not answered `uitest`/);
  });

  it("ignores a second emulator that was connected and driveable before the start", async () => {
    // The pre-start snapshot is the only thing standing between this boot and a
    // peer emulator: it is TCP like ours, so the USB filter passes it, and off
    // the same device profile it answers the same panel, so the confirmation
    // passes it too. Every other fixture's pre-existing row is USB or
    // `Offline`, i.e. excluded by something else.
    targets([PHONE, foreignTarget], [PHONE, foreignTarget, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses rather than starting blind when the pre-start listing cannot be read", async () => {
    // A failed listing read as an empty one makes every already-connected
    // emulator this boot's arrival. Refused before the spawn, so there is no
    // instance left running behind the error.
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("[Fail]Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const assertion = expect(pending).rejects.toThrow(/could not have been told apart/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("takes the snapshot on a retry rather than failing the boot for one bad listing", async () => {
    // The `hdc` daemon restarting after a `-stop` is the likely cause and it
    // clears, so one refusal must not cost the caller the boot.
    let call = 0;
    const next = () => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("[Fail]Connect server failed"));
      return Promise.resolve(call <= 2 ? [PHONE] : [PHONE, emulatorTarget]);
    };
    listHarmonyHdcTargets.mockImplementation(next);
    listHarmonyHdcTargetsStrict.mockImplementation(next);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("removes the readiness probe's dump instead of leaving one per boot in tmpdir", async () => {
    // A full `uitest dumpLayout` JSON, and nothing else prunes it.
    const probes: string[] = [];
    harmonyDumpLayout.mockImplementation((_key: unknown, path: string) => {
      probes.push(path);
      writeFileSync(path, "{}");
      return Promise.resolve({ attributes: {} });
    });
    targets([PHONE], [PHONE, emulatorTarget]);

    await boot({});

    expect(probes).toHaveLength(1);
    expect(existsSync(probes[0]!)).toBe(false);
  });

  it("caps the readiness probe at what is left of the budget", async () => {
    // The probe outlives the wait that abandons it: `uitest` is serialized per
    // device, so a 20s client still running after boot-device returned is 20s
    // the caller's first interaction spends queued — and `HARMONY_NOT_DRIVABLE`
    // is precisely the answer that tells them to retry it.
    const probes: { at: number; timeoutMs?: number }[] = [];
    harmonyDumpLayout.mockImplementation((_key: unknown, path: string, timeoutMs?: number) => {
      probes.push({ at: Date.now(), timeoutMs });
      writeFileSync(path, "{}");
      return new Promise(() => {}); // never answers, like a guest still coming up
    });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    // Under `uitest`'s own 20s ceiling, so a probe taking that ceiling would
    // outlive the boot — which is the whole failure being pinned.
    const startedAt = Date.now();
    const pending = boot({ bootTimeoutMs: 10_000 });
    const settled = expect(pending).resolves.toMatchObject({
      note: expect.stringMatching(/uitest/),
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await settled;

    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe.timeoutMs).toBeGreaterThan(0);
      // Killed by the deadline at the latest — never `uitest`'s own ceiling
      // measured from whenever this probe happened to start.
      expect(probe.at + probe.timeoutMs!).toBeLessThanOrEqual(startedAt + 10_000);
    }
  });

  it("caps the target listing at what is left of the budget too", async () => {
    // The listing opens every poll round, so its own 8s ceiling is spent on top
    // of the budget rather than inside it: the round that starts with 6s left
    // still hands `hdc` 8, and the boot answers 2s late every time the last
    // round lands there.
    const listings: { at: number; timeoutMs?: number }[] = [];
    // The snapshot before the start is not one of the wait's rounds, and is not
    // paid out of its budget.
    listHarmonyHdcTargetsStrict.mockResolvedValueOnce([PHONE]);
    listHarmonyHdcTargetsStrict.mockImplementation((timeoutMs?: number) => {
      listings.push({ at: Date.now(), timeoutMs });
      // Long enough that rounds start at 0/6s/12s/…, so one of them opens
      // inside the last 8s of the budget with the ceiling still to pay.
      return new Promise((resolve) => setTimeout(() => resolve([PHONE]), 4_000));
    });
    vi.useFakeTimers();

    const startedAt = Date.now();
    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).resolves.toMatchObject({
      note: expect.stringMatching(/bootTimeoutMs/),
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await settled;

    expect(listings.length).toBeGreaterThan(1);
    for (const listing of listings) {
      expect(listing.timeoutMs).toBeGreaterThan(0);
      expect(listing.at + listing.timeoutMs!).toBeLessThanOrEqual(startedAt + 30_000);
    }
  });

  it("classifies a manager that died inside the arrival wait's final poll interval", async () => {
    // The arrival wait's sleep is clamped to the remaining budget, so the loop
    // always comes back to its top with none left. A manager that died during
    // that last interval must still be classified there — otherwise the boot
    // falls through to `booted: true` under a note telling the caller to raise
    // `bootTimeoutMs` for a start that crashed.
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/nothing is running to drive/);
    await vi.advanceTimersByTimeAsync(29_000);
    child.die("error: the emulator instance quit unexpectedly (disk image corrupted)");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it("does not blame hdc when the budget expired before the wait could ask it once", async () => {
    // A force restart deliberately gives the shutdown the whole remaining
    // budget. The pre-start snapshot then succeeds on its very last moment, and
    // the target wait's first look has nothing left: the note has to say the
    // budget ran out before the wait asked `hdc` once — not that `hdc` failed
    // every time it was asked, which here it never was.
    listHarmonyInstances
      .mockResolvedValueOnce([
        { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true, display: PANEL },
      ])
      .mockResolvedValue([
        { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false, display: PANEL },
      ]);
    // The snapshot succeeds at the exact instant the budget expires.
    listHarmonyHdcTargetsStrict.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([PHONE]), 6_000))
    );
    listHarmonyHdcTargets.mockResolvedValue([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 6_000 }) as Promise<{
      udid: string;
      note?: string;
    }>;
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;

    expect(result.udid).toBe("harmony-emulator-Phone_1");
    expect(result.note).not.toContain("`hdc list targets` failed");
    expect(result.note).toMatch(/before argent could ask/);
  });

  it("serializes a plain and a forced boot of the same stopped instance", async () => {
    // When the instance is not already running the two calls do identical work,
    // so keying the map by `force` ran `-start` twice for one instance at once —
    // one caller told nothing is running while the other handed back the booted
    // key. Joined on the instance alone they take turns instead when their
    // `force` differs: the plain boot starts it, the forced one restarts it,
    // and neither answer contradicts the other.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          // Down for the first boot's opening check, up for the forced boot's,
          // down again once its stop-wait starts polling.
          running: listed++ === 1,
          display: PANEL,
        },
      ])
    );
    targets(
      [PHONE],
      [PHONE, emulatorTarget],
      [PHONE, staleEmulatorTarget],
      [PHONE, staleEmulatorTarget, emulatorTarget]
    );
    vi.useFakeTimers();

    const plain = boot({ bootTimeoutMs: 30_000 });
    const forced = boot({ force: true, bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const [a, b] = (await Promise.all([plain, forced])) as Array<{ udid: string; note?: string }>;

    expect(a.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(b.udid).toBe(`harmony-${EMULATOR_KEY}`);
    // The restart followed the start it was serialized behind, not a parallel
    // run of it: `-stop` was issued only once the first `-start` had spawned.
    const stopOrder = runHarmonyEmulator.mock.invocationCallOrder[0]!;
    const startOrder = spawnMock.mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeGreaterThan(startOrder);
  });

  it("clamps the no-connector grace against the boot deadline", async () => {
    // Every other wait on this path caps against the caller's budget; the
    // manager-exit grace built its own 3s deadline instead, so a host with no
    // `hdc` and a small budget waited past the `bootTimeoutMs` it was given.
    resolveHdc.mockResolvedValue(null);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_100);
    const result = (await pending) as { booted: boolean; note?: string };
    expect(result.booted).toBe(true);
  });

  it("gives each boot attempt its own start log", async () => {
    // Two boots of one instance — across two tool-server processes, or past the
    // coalescing window's edge inside one — used to share a path opened `"w"`,
    // so the loser's diagnostic was truncated before anyone read it.
    targets([PHONE], [PHONE, emulatorTarget]);
    await boot({});
    targets([PHONE], [PHONE, emulatorTarget]);
    await boot({});

    const paths = harmonyLogs(INSTANCE);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("boots without a log when the temp directory cannot be written", async () => {
    // An unwritable tmpdir used to escape as a raw `Error` ahead of any failure
    // signal. Degrading to a log-less start keeps the boot classifiable — the
    // diagnostic reads "(nothing)" — which is honest about what happened.
    // `/dev/null` is a file, so opening anything beneath it fails every time.
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = "/dev/null/argent-unwritable";
    try {
      targets([PHONE], [PHONE, emulatorTarget]);

      const result = (await boot({})) as { booted: boolean };
      expect(result.booted).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        expect.anything(),
        ["-start", INSTANCE],
        expect.objectContaining({ stdio: "ignore" })
      );
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }
  });

  it("reports the manager's death during the readiness wait, not a slow guest", async () => {
    // The wait for the target polls the exit latch for exactly this reason, and
    // the readiness wait sits in the same window: a dead emulator answers no
    // probe, which is what one still starting its window service looks like.
    // Without the latch the boot spends the rest of the budget on a corpse and
    // then hands back a drivable id telling the caller to retry.
    harmonyDumpLayout.mockImplementation(() => {
      child.die("error: the emulator instance quit unexpectedly (disk image corrupted)");
      return Promise.reject(new Error("DumpLayout failed:Get window nodes failed"));
    });
    targets([PHONE], [PHONE, emulatorTarget]);

    // The key WAS resolved — it is what the failing probe is aimed at — so the
    // message the pre-registration wait uses would deny the registration that
    // had already happened.
    const err = (await boot({ bootTimeoutMs: 30_000 }).catch((e: unknown) => e)) as Error;

    expect(err.message).toMatch(/disk image corrupted/);
    expect(err.message).toMatch(/`127\.0\.0\.1:5555`\) was still coming up/);
    expect(err.message).not.toMatch(/before "Phone_1" registered/);
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_MANAGER_EXITED,
      failure_command: "deveco_emulator",
    });
  });

  it("removes the readiness probe's dump when the wait ends by throwing", async () => {
    // The other exit from that wait. Cleanup hung on the return paths instead of
    // a `finally` leaves a full `uitest dumpLayout` JSON per dead boot, on the
    // path where boots are most likely to be retried.
    const probes: string[] = [];
    harmonyDumpLayout.mockImplementation((_key: unknown, path: string) => {
      probes.push(path);
      writeFileSync(path, "{}");
      child.die("error: the emulator instance quit unexpectedly (disk image corrupted)");
      return Promise.reject(new Error("DumpLayout failed:Get window nodes failed"));
    });
    targets([PHONE], [PHONE, emulatorTarget]);

    await expect(boot({ bootTimeoutMs: 30_000 })).rejects.toThrow(/disk image corrupted/);

    expect(probes).toHaveLength(1);
    expect(existsSync(probes[0]!)).toBe(false);
  });

  it("does not start a readiness probe there is no budget left to read", async () => {
    // An instance with no configured panel is confirmed on arrival alone, so the
    // key can resolve at the deadline itself with nothing left for the readiness
    // wait. A probe launched then answers to nobody and holds this device's
    // `uitest` queue for its own timeout — which the retry the note asks for
    // would queue behind.
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false, display: null },
    ]);
    // Each listing costs a third of the budget, so the arrival lands on the poll
    // that exhausts it.
    const rounds = [[PHONE], [PHONE], [PHONE, emulatorTarget]];
    let call = 0;
    const next = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(rounds[Math.min(call++, rounds.length - 1)]), 10_000)
      );
    listHarmonyHdcTargets.mockImplementation(next);
    listHarmonyHdcTargetsStrict.mockImplementation(next);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(harmonyDumpLayout).not.toHaveBeenCalled();
    // Both caveats, and neither claiming the guest was asked anything.
    expect(result.note).toMatch(/had not answered `uitest`/);
    expect(result.note).toMatch(/no panel on record/);
  });

  it("names the declined target, not the unreadable one, when it saw both", async () => {
    // A target that answered someone else's panel is a firmer diagnosis than one
    // that answered nothing, so it is the one worth reporting — and the note it
    // selects is the only place the difference reaches the caller.
    const unprobeable = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    harmonyDisplay.mockImplementation((key: string) =>
      key === unprobeable.connectKey
        ? Promise.reject(new Error("hidumper: no answer"))
        : Promise.resolve({ width: 466, height: 466, screenOn: true })
    );
    targets([PHONE], [PHONE, emulatorTarget, unprobeable]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { note?: string };

    expect(result.note).toMatch(/is not the panel/);
    expect(result.note).not.toMatch(/never reported a display/);
  });

  it("says the key rests on arrival alone when the instance has no panel to check it against", async () => {
    // A multi-display profile keys its LCDs differently, so `display` is null on
    // a perfectly good instance — and the check that separates it from another
    // device reconnecting in the same window has nothing to compare against.
    // Returning the key unremarked is how a later tap lands on that device.
    listHarmonyInstances.mockResolvedValue([
      {
        name: INSTANCE,
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
    ]);
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = (await boot({})) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/no panel on record for this instance/);
    expect(harmonyDisplay).not.toHaveBeenCalled();
  });

  it("re-probes a target that read wrong once instead of disqualifying it for the boot", async () => {
    // A guest mid-boot has not settled: this platform's flagship form factors
    // are foldables, whose resolution changes with the fold. Latching the first
    // reading rejects the instance argent itself started, for the whole budget.
    harmonyDisplay
      .mockResolvedValueOnce({ width: 1080, height: 2340, screenOn: true })
      .mockResolvedValue({ ...PANEL, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
    expect(harmonyDisplay.mock.calls.length).toBeGreaterThan(1);
  });

  it("reads a 0x0 panel as a guest that has not composited, not as another device", async () => {
    // The manager side refuses zero as a panel, so reading it as someone else's
    // would have the two sides of the one joining value disagree — and would
    // report a guest that never got as far as compositing as proof that the
    // target belongs to some other device.
    harmonyDisplay.mockResolvedValue({ width: 0, height: 0, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.note).toMatch(/never reported a display argent could read/);
    expect(result.note).not.toMatch(/is not the panel/);
  });

  it("does not blame `hdc` registration for a target that registered but never reported a panel", async () => {
    // "had not registered with `hdc`" is a plain untruth here, and it sends the
    // caller to raise a budget that was never the problem.
    harmonyDisplay.mockRejectedValue(new Error("hidumper produced no render resolution"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/never reported a display argent could read/);
    expect(result.note).not.toMatch(/had not registered/);
  });

  it("says the device table was unreadable rather than that nothing registered", async () => {
    // `hdc` dying mid-boot (a killed server, a client/server version mismatch)
    // makes every poll throw. Swallowed into an empty listing it reads as an
    // instance that never registered, which sends the caller to raise a budget
    // that was never the problem and to look at an emulator that may be fine —
    // argent could not ask. The snapshot before the start already refuses this
    // condition outright; the wait after it has to name it too.
    //
    // The snapshot succeeds (it is what decides the boot may proceed at all),
    // so the failure below is only ever the wait's.
    //
    // Both listers are stubbed the way `hdc` really answers a dead server:
    // exit 0, a diagnostic, no rows — which the strict listing refuses and the
    // TOLERANT one reports as an empty table. A wait reading the tolerant
    // answer therefore sees "nothing has registered yet" and blames the budget,
    // so pinning the note pins which of the two the wait asks.
    listHarmonyHdcTargetsStrict.mockResolvedValueOnce([PHONE]);
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("[Fail]Connect server failed"));
    listHarmonyHdcTargets.mockResolvedValue([]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    // The boot still happened and still answers with the instance id.
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc list targets` failed every time/);
    // Not the wrong diagnosis, and not the wrong remedy.
    expect(result.note).not.toMatch(/had not registered/);
    expect(result.note).not.toMatch(/bootTimeoutMs/);
  });

  it("carries both caveats when the key is neither checked nor answering", async () => {
    // One `note` field, two independent things left unproven. Dropping either
    // for the other has the payload assert something the boot did not establish.
    listHarmonyInstances.mockResolvedValue([
      {
        name: INSTANCE,
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
    ]);
    harmonyDumpLayout.mockRejectedValue(new Error("DumpLayout failed:Get window nodes failed"));
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toMatch(/no panel on record for this instance/);
    expect(result.note).toMatch(/had not answered `uitest`/);
  });

  it("names the instance and says why when nothing registers within the budget", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(spawnMock).toHaveBeenCalled();
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/bootTimeoutMs/);
  });

  it("blames the missing connector instead of waiting out the budget for it", async () => {
    resolveHdc.mockResolvedValue(null);
    vi.useFakeTimers();

    const pending = boot({});
    // The arrival wait is skipped outright without `hdc`; what remains is the
    // short grace that watches the manager for an immediate failure, so this
    // advances past that rather than the boot budget.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc` was not found/);
  });

  it("does not claim the instance started when the manager already died and hdc is missing", async () => {
    // With no connector the arrival wait is skipped, so nothing else ever
    // consults the manager - and the note it would otherwise return opens with
    // "The instance started", which at that point nothing had checked.
    // The manager dies while the connector is being looked for, which is the
    // real ordering: `Emulator -start` fails in milliseconds, the `hdc` lookup
    // is a filesystem probe.
    resolveHdc.mockResolvedValue(null);
    setTimeout(
      () => child.die("Failed to start emulator: this emulator instance is already running"),
      5
    );

    await expect(boot({})).rejects.toThrow(/already running/);
  });

  it("fails fast when the manager dies before the instance registers", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/Unable to start the emulator/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die("Unable to start the emulator", 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("blames the region when a dead manager reports the image restriction", async () => {
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/only within mainland China/);
    await vi.advanceTimersByTimeAsync(1_000);
    child.die("Currently, this capability is available only in the Chinese mainland.");
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
  });

  it("points at creating an instance when the start failed and none exist", async () => {
    // An empty listing is not a refusal of its own: `listHarmonyInstances`
    // answers `[]` for a `-list` that ran and printed a diagnostic too, so a
    // host whose images are missing must still reach the start rather than be
    // told it has no instances by a listing that could not see them.
    listHarmonyInstances.mockResolvedValue([]);
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/Create one in DevEco Studio if there is none/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
    child.die(`"${INSTANCE}" is not found. Please create the device(folder): /x`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;

    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_START_FAILED,
      failure_command: "deveco_emulator",
    });
  });

  it("names the instances the host does have, rather than starting one it does not", async () => {
    // The name is the caller's to spell and the listing is already in hand, so
    // a typo is answered here — not by spending the budget on a start whose
    // failure quotes the manager naming nothing that exists.
    listHarmonyInstances.mockResolvedValue([
      { name: "Tablet_9", deviceType: "Tablet", osVersion: null, running: false },
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false },
    ]);
    targets([PHONE]);

    const failed = await boot({ harmonyInstance: "Phone1", bootTimeoutMs: 900_000 }).catch(
      (e: unknown) => e
    );

    expect((failed as Error).message).toMatch(
      /"Phone1" not found\. Available: Tablet_9, Phone_1\./
    );
    expect(getFailureSignal(failed)).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_INSTANCE_NOT_FOUND,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still starts the instance when the listing itself could not be read", async () => {
    // An unreadable list answers nothing, so it must not be read as "none" —
    // that would refuse a boot of an instance the host has.
    listHarmonyInstances.mockRejectedValue(new Error("Emulator: spawn EACCES"));
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 900_000 });
    const settled = expect(pending).rejects.toThrow(/is not found\. Please create the device/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
    child.die(`"${INSTANCE}" is not found. Please create the device(folder): /x`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await settled;
    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_START_FAILED,
      failure_command: "deveco_emulator",
    });
  });

  it("leaves a running instance alone and says how to reach it", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);

    const result = (await boot({})) as { udid: string; note?: string };

    expect(spawnMock).not.toHaveBeenCalled();
    expect(runHarmonyEmulator).not.toHaveBeenCalled();
    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/already running/);
  });

  it("restarts a running instance on force and resolves the key it comes back on", async () => {
    // `-stop` returns before the emulator is gone, so the restart waits on
    // `isRunning` — and for the whole budget, since how long the instance then
    // takes to go down is unpredictable (9s to ~70s measured). Reported running
    // for 40s here, past any fixed grace.
    //
    // The stopped instance is modelled as an `Offline` ROW rather than an absent
    // one, because that is what a device does: `-stop` takes the guest down and
    // leaves `127.0.0.1:5555  TCP  Offline` behind. A fixture where the key
    // vanishes and reappears cannot fail, since the key is then fresh whatever
    // the snapshot kept.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          running: listed++ < 21,
          display: PANEL,
        },
      ])
    );
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE], expect.any(Number));
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("does not start the instance when stopping it for a restart failed", async () => {
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    runHarmonyEmulator.mockResolvedValue({
      stdout: `"${INSTANCE}" failed, emulator is not exists`,
      stderr: "",
    });

    await expect(boot({ force: true })).rejects.toThrow(/Failed to stop HarmonyOS emulator/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("classifies its refusals the way every other platform in this tool does", async () => {
    // Android and Vega throw `FailureError` with a granular code from this same
    // file; a bare `Error` buckets as REGISTRY_TOOL_EXECUTION_FAILED, which puts
    // "the manager is not installed" and "this instance would not stop" in one
    // undifferentiated row — and drops the binary that failed with them.
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    runHarmonyEmulator.mockResolvedValue({
      stdout: `"${INSTANCE}" failed, emulator is not exists`,
      stderr: "",
    });
    const stopFailure = await boot({ force: true }).then(
      () => null,
      (e: unknown) => e
    );
    expect(getFailureSignal(stopFailure)).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_STOP_FAILED,
      failure_command: "deveco_emulator",
    });

    vi.clearAllMocks();
    ensureDep.mockResolvedValue(undefined);
    resolveHdc.mockResolvedValue("/Applications/DevEco-Studio.app/.../hdc");
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false },
    ]);
    listHarmonyHdcTargets.mockResolvedValue([]);
    listHarmonyHdcTargetsStrict.mockResolvedValue([]);
    resolveHarmonyEmulator.mockResolvedValue(null);
    const missingBinary = await boot({}).then(
      () => null,
      (e: unknown) => e
    );
    expect(getFailureSignal(missingBinary)).toMatchObject({
      error_code: FAILURE_CODES.HARMONY_EMULATOR_NOT_FOUND,
      error_kind: "dependency_missing",
    });
  });

  it("does not start an instance the stop never brought down", async () => {
    // One measured `-stop` had still not taken effect three minutes later, so
    // the instance being down is never assumable — and one still up when the
    // budget ends would make `-start` report only that it is already running.
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true },
    ]);
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 60_000 });
    const settled = expect(pending).rejects.toThrow(/still running when the 60s budget ran out/);
    await vi.advanceTimersByTimeAsync(61_000);
    await settled;

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE], expect.any(Number));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_STOP_TIMEOUT,
      failure_command: "deveco_emulator",
    });
  });

  it("caps the stop-wait listing at what is left of the budget", async () => {
    // Same shape one stage earlier: a `force` restart pays for the shutdown out
    // of the boot's budget, so the listing that watches for the instance to go
    // down must not run past the deadline the caller set for the whole restart.
    const listings: { at: number; timeoutMs?: number }[] = [];
    listHarmonyInstances.mockImplementation((timeoutMs?: number) => {
      listings.push({ at: Date.now(), timeoutMs });
      return new Promise((resolve) =>
        setTimeout(
          () => resolve([{ name: INSTANCE, deviceType: "Phone", osVersion: null, running: true }]),
          3_500
        )
      );
    });
    vi.useFakeTimers();

    const startedAt = Date.now();
    const pending = boot({ force: true, bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/still running when the 30s budget ran out/);
    await vi.advanceTimersByTimeAsync(40_000);
    await settled;

    // The pre-stop lookup runs unbounded; every wait round after it is the
    // one on the clock.
    const waitRounds = listings.slice(1);
    expect(waitRounds.length).toBeGreaterThan(1);
    for (const listing of waitRounds) {
      expect(listing.timeoutMs).toBeGreaterThan(0);
      expect(listing.at + listing.timeoutMs!).toBeLessThanOrEqual(startedAt + 30_000);
    }
    // 3.5s per listing and a 2s poll between them leave the last round 1s of
    // budget, so its sleep is clamped and the loop comes back around exactly on
    // the deadline — the round that has to give up rather than open a listing
    // with nothing left to bound it.
    expect(waitRounds.at(-1)!.at).toBeLessThan(startedAt + 30_000);
  });

  it("pays for a `force` restart's stop and snapshot out of the budget, not on top of it", async () => {
    // The shutdown is given the whole remaining budget by design, so reaching
    // the pre-start snapshot with almost none left is the ordinary `force` case
    // rather than the odd one. Left on their own ceilings from there, `-stop`
    // (30s) and the snapshot listing (8s, and again after a retry) answer a
    // third of a minute past the budget the caller set — and the wait they feed
    // then returns on its first line, so the overspend buys nothing.
    const calls: { at: number; timeoutMs?: number }[] = [];
    runHarmonyEmulator.mockImplementation((args: string[], timeoutMs?: number) => {
      if (args[0] === "-stop") calls.push({ at: Date.now(), timeoutMs });
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    listHarmonyHdcTargetsStrict.mockImplementation((timeoutMs?: number) => {
      calls.push({ at: Date.now(), timeoutMs });
      return new Promise((resolve) => setTimeout(() => resolve([PHONE]), 4_000));
    });
    // Four seconds per listing and a 2s poll between them puts the instance's
    // shutdown at 26s of a 30s budget.
    let listed = 0;
    listHarmonyInstances.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve([
                {
                  name: INSTANCE,
                  deviceType: "Phone",
                  osVersion: null,
                  running: listed++ < 4,
                  display: PANEL,
                },
              ]),
            4_000
          )
        )
    );
    vi.useFakeTimers();

    const startedAt = Date.now();
    const pending = boot({ force: true, bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(90_000);
    await pending;

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.at + call.timeoutMs!).toBeLessThanOrEqual(startedAt + 30_000);
    }
  });

  it("says the instance is down when a `force` restart refuses at the snapshot", async () => {
    // The one refusal that leaves the host somewhere the caller never asked to
    // be: `-stop` has already run, so "the device table could not be read"
    // arrives with the instance down and nothing started in its place. Read as
    // "nothing happened" it costs the caller a working emulator they still
    // believe is up.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          running: listed++ < 1,
          display: PANEL,
        },
      ])
    );
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(
      /`force` had already stopped "Phone_1", which is still down/
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE], expect.any(Number));
    expect(spawnMock).not.toHaveBeenCalled();
    // `hdc`, not the manager: this refusal is the device table being unreadable,
    // and the binary named is what the caller has to go and check.
    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_TARGET_LIST_FAILED,
      failure_command: "hdc",
    });
  });

  it("reports a wedged `hdc` as the timeout its own wrapper classified it as", async () => {
    // `runHdc` is the frame that can tell a client SIGKILLed at its ceiling from
    // one that failed, and it does. Stamping a kind here instead of carrying
    // that one up re-buckets the single case those wrappers were taught to
    // separate, and `getFailureSignal` takes the OUTERMOST signal — so the
    // telemetry keeps this frame's answer, not the true one.
    listHarmonyHdcTargetsStrict.mockRejectedValue(
      new FailureError("hdc list targets timed out", {
        error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
        failure_stage: "harmony_hdc_run",
        failure_area: "tool_server",
        error_kind: "timeout",
      })
    );
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/Could not read `hdc`'s device table/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_TARGET_LIST_FAILED,
      error_kind: "timeout",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still calls a listing that merely failed a subprocess failure", async () => {
    // The fallback has to stay: `listHarmonyHdcTargetsStrict` refuses a
    // diagnostic with a plain `Error`, which carries no signal to inherit.
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/Could not read `hdc`'s device table/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(getFailureSignal(await pending.catch((e: unknown) => e))?.error_kind).toBe("subprocess");
  });

  it("stops probing arrivals once the budget is spent, rather than once per arrival", async () => {
    // Each probe carries its own timeout and takes no budget from the wait, so
    // probing every arrival in turn multiplies `bootTimeoutMs` by however many
    // rows reconnected — 95s against a 30s budget, measured. Three arrivals at
    // 20s apiece is that shape: one round already outlasts two budgets.
    const slowPanel = { width: 1, height: 1, screenOn: true };
    const probes: number[] = [];
    harmonyDisplay.mockImplementation(() => {
      probes.push(Date.now());
      return new Promise((resolve) => setTimeout(() => resolve(slowPanel), 20_000));
    });
    const peers = [1, 2, 3].map((i) => ({
      connectKey: `127.0.0.1:555${i}`,
      connection: "TCP",
      state: "Connected",
    }));
    targets([PHONE], [PHONE, ...peers]);
    vi.useFakeTimers();

    const startedAt = Date.now();
    const pending = boot({ bootTimeoutMs: 30_000 });
    const elapsed = pending.then(() => Date.now() - startedAt);
    await vi.advanceTimersByTimeAsync(200_000);

    // The budget is the caller's word on how long boot-device may take, so what
    // is asserted is the clock, not the probe count: a boot that answers late is
    // the failure, however few calls it made getting there.
    expect(await elapsed).toBeLessThanOrEqual(30_000);
    expect(((await pending) as { note?: string }).note).toMatch(/registered/);
    // Abandoning the wait is not enough: the first probe eats the whole budget,
    // so the two arrivals behind it must never be spawned at all. An `hdc`
    // client started at the deadline is one nothing will ever read, still
    // holding the guest for its own 20s ceiling.
    expect(probes.length).toBeGreaterThan(0);
    for (const at of probes) expect(at).toBeLessThan(startedAt + 30_000);
  });

  // Every one of these lookups is `i.name === params.instanceName` against a
  // listing that, in every other fixture here, holds exactly one instance — so
  // the name match itself is a free variable. A developer machine with a phone
  // and a tablet profile is the ordinary case, not an exotic one.
  describe("with more than one instance on the host", () => {
    /** `other` first, so a lookup that takes `instances[0]` takes the wrong one. */
    const instances = (mine: { running: boolean }, other: { running: boolean }) => [
      {
        name: "Tablet_9",
        deviceType: "Tablet",
        osVersion: null,
        running: other.running,
        display: { width: 2200, height: 1400 },
      },
      {
        name: INSTANCE,
        deviceType: "Phone",
        osVersion: null,
        running: mine.running,
        display: PANEL,
      },
    ];

    it("checks the panel of the instance it was asked for, not the first listed", async () => {
      listHarmonyInstances.mockResolvedValue(instances({ running: false }, { running: false }));
      targets([PHONE], [PHONE, emulatorTarget]);

      const result = (await boot({})) as { udid: string; note?: string };

      // The arrival answers PANEL. Read against the tablet's profile it is a
      // stranger, and the boot hands back an id no interaction tool accepts.
      expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
      expect(result.note).toBeUndefined();
    });

    it("does not treat another instance being up as this one already running", async () => {
      listHarmonyInstances.mockResolvedValue(instances({ running: false }, { running: true }));
      targets([PHONE], [PHONE, emulatorTarget]);

      const result = (await boot({})) as { udid: string; note?: string };

      // Without the name match this returns `booted: true` on the tablet's
      // account and never starts anything.
      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        ["-start", INSTANCE],
        expect.any(Object)
      );
      expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
      expect(result.note).toBeUndefined();
    });

    it("waits out only its own instance's shutdown, not another's", async () => {
      // The tablet stays up throughout. A stop-wait that asks "is anything
      // running" instead of "is this running" never sees the restart complete
      // and spends the whole budget on a peer it was never asked about.
      let listed = 0;
      listHarmonyInstances.mockImplementation(() =>
        Promise.resolve(instances({ running: listed++ < 1 }, { running: true }))
      );
      targets([PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
      vi.useFakeTimers();

      const pending = boot({ force: true, bootTimeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = (await pending) as { udid: string; note?: string };

      expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
      expect(result.note).toBeUndefined();
    });
  });

  it("refuses a target that matches the panel on one axis only", async () => {
    // The comparison is min/min and max/max so a landscape guest still matches
    // its portrait config. Comparing one axis would let any device sharing a
    // width — 1320x2400 against this 1320x2856 — be adopted as the instance
    // argent started, after which every tap lands on someone else's screen.
    harmonyDisplay.mockResolvedValue({ width: PANEL.width, height: 2400, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/is not the panel/);
  });

  it("keeps waiting through a stop-wait listing that could not be read", async () => {
    // "An unreadable listing answers nothing, so it keeps waiting rather than
    // assuming the instance is gone" — read as `stopped` instead, one transient
    // `Emulator -list` failure sends `-start` at a live instance, which answers
    // only that it is already running.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() => {
      listed += 1;
      if (listed === 1)
        return Promise.resolve([
          { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true, display: PANEL },
        ]);
      return Promise.reject(new Error("Emulator -list failed"));
    });
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/still running when the 30s budget ran out/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps waiting through a stop-wait listing that answered no rows at all", async () => {
    // The sibling case: `listHarmonyInstances` resolves `[]` for a `-list` that
    // ran and printed a diagnostic, not only for a host with no instances — and
    // an instance that stopped keeps a row of its own, with `isRunning` false.
    // So no rows is the unreadable answer, and taking it for a shutdown sends
    // `-start` at an instance still up.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() => {
      listed += 1;
      if (listed === 1)
        return Promise.resolve([
          { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true, display: PANEL },
        ]);
      return Promise.resolve([]);
    });
    vi.useFakeTimers();

    const pending = boot({ force: true, bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/still running when the 30s budget ran out/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("gives two instances that differ only in an unsafe character their own start logs", async () => {
    // The log is opened `"w"`, so collapsing every unsafe character onto `_`
    // would point "Phone 1" and "Phone_1" at one file — and a boot of the second
    // truncates the first's diagnostic while its manager is still dying, leaving
    // that failure to be reported with nothing printed.
    const children: FakeEmulator[] = [];
    spawnMock.mockImplementation(() => {
      const spawned = new FakeEmulator();
      children.push(spawned);
      return spawned;
    });
    listHarmonyInstances.mockResolvedValue([
      { name: SPACED_INSTANCE, deviceType: "Phone", osVersion: null, running: false },
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false },
    ]);
    vi.useFakeTimers();

    const spaced = boot({ harmonyInstance: SPACED_INSTANCE, bootTimeoutMs: 900_000 });
    const spacedSettled = expect(spaced).rejects.toThrow(/Cannot find image for the profile/);
    await vi.advanceTimersByTimeAsync(1_000);
    const spacedLogs = harmonyLogs(SPACED_LOG_PREFIX.slice("argent-harmony-".length));
    expect(spacedLogs.length, "the spaced instance opened no start log").toBeGreaterThan(0);
    writeFileSync(join(tmpdir(), spacedLogs.at(-1)!), "Cannot find image for the profile\n");

    const underscored = boot({ bootTimeoutMs: 900_000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);

    children[0].emit("exit", 1, null);
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(3_000);
    await spacedSettled;
    await underscored;
  });

  it("reports a manager that could not be spawned instead of taking the server down", async () => {
    // `spawn` fails asynchronously for ENOENT/EACCES. An unhandled `error` event
    // is an uncaughtException, which this process routes to crashShutdown — so
    // one unlaunchable emulator would stop every other device's session too.
    // The Android arm has its own file pinning exactly this.
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn Emulator ENOENT")));
      return child;
    });
    targets([PHONE]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/could not be spawned: spawn Emulator ENOENT/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;
  });

  it("returns an id the interaction tools accept, which the instance id is not", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const { udid } = (await boot({})) as { udid: string };

    // The point of resolving the key at all: what boot-device hands back has to
    // be drivable. Both halves matter — the instance id is rejected by the same
    // gate, so a payload carrying it strands the caller.
    const describe = createDescribeTool({} as Registry);
    expect(() =>
      assertSupported("describe", describe.capability, resolveDevice(udid))
    ).not.toThrow();
    expect(() =>
      assertSupported(
        "describe",
        describe.capability,
        resolveDevice(`harmony-emulator-${INSTANCE}`)
      )
    ).toThrow(/not supported on harmony emulator/);
  });

  it("coalesces two concurrent boots of one instance into a single start", async () => {
    // `Emulator -start` twice for one instance is two managers racing over the
    // same instance directory; the second reports "already running" and the
    // caller that asked first can no longer tell whose emulator it got.
    targets([PHONE], [PHONE, emulatorTarget]);

    const [a, b] = await Promise.all([boot({}), boot({})]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("does not let a `force` boot join a plain one that would skip the restart", async () => {
    // The restart is the whole point of `force`: joined to a plain boot, the
    // caller is handed a payload for an instance that was never restarted — and
    // on this platform that also means no connect key was resolved, since only
    // a boot argent performed can be matched to the key it registers under.
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          // Running for both boots' opening check, down once the restart's
          // stop-wait starts polling.
          running: listed++ < 2,
          display: PANEL,
        },
      ])
    );
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = Promise.all([boot({}), boot({ force: true })]);
    await vi.advanceTimersByTimeAsync(60_000);
    const [plain, forced] = (await pending) as { udid: string; note?: string }[];

    expect(runHarmonyEmulator).toHaveBeenCalledWith(["-stop", INSTANCE], expect.any(Number));
    expect(plain.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(plain.note).toMatch(/already running/);
    expect(forced.udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("starts the instance behind a harmony-emulator- udid", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = await createBootDeviceTool(registry).execute!(
      {},
      { udid: `harmony-emulator-${INSTANCE}` }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["-start", INSTANCE],
      expect.any(Object)
    );
    expect(result).toMatchObject({ instanceName: INSTANCE, udid: `harmony-${EMULATOR_KEY}` });
  });

  it("does not read a connect-key id as an instance name", async () => {
    // A device id passed where a boot target belongs is refused under the
    // spelling it was given — nothing strips the prefix and starts whatever is
    // left of it, which would boot an instance the caller never named.
    const failed = await boot({
      harmonyInstance: `harmony-${PHONE.connectKey}`,
      bootTimeoutMs: 30_000,
    }).catch((e: unknown) => e);

    expect((failed as Error).message).toContain(`"harmony-${PHONE.connectKey}" not found`);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

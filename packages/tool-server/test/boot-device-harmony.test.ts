import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
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
/** What a booted emulator registers as. */
const EMULATOR_KEY = "127.0.0.1:5555";
const emulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Connected" };
/** A stopped instance's row survives as `Offline` and re-registers on the same port. */
const staleEmulatorTarget = { connectKey: EMULATOR_KEY, connection: "TCP", state: "Offline" };
/** A second emulator, already up and driveable when this boot starts. */
const foreignTarget = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Connected" };
/** `hw.lcd.single.width`/`height` of the phone image, echoed by the guest's `render resolution`. */
const PANEL = { width: 1320, height: 2856 };
/** Newest last, ordered by the numeric hrtime suffix (its digit count varies). */
function harmonyLogs(safeName: string): string[] {
  const seq = (f: string) => BigInt(/-(\d+)\.log$/.exec(f)?.[1] ?? 0);
  return readdirSync(tmpdir())
    .filter((f) => f.startsWith(`argent-harmony-${safeName}`) && f.endsWith(".log"))
    .sort((a, b) => (seq(a) < seq(b) ? -1 : seq(a) > seq(b) ? 1 : 0));
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
    // `Emulator -start` never exits while the emulator runs; `child` never emits `exit`.
    targets([PHONE], [PHONE, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(child.unref).toHaveBeenCalled();
  });

  it("ignores a target that was already connected before the start", async () => {
    targets([PHONE], [PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("only counts a target once it is Connected", async () => {
    // Different keys, so adopting the `Offline` row early would be caught.
    const offlineOther = { connectKey: "127.0.0.1:5559", connection: "TCP", state: "Offline" };
    targets([PHONE], [PHONE, offlineOther], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({});
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("resolves the key an instance comes back on, though its row never left the listing", async () => {
    // The instance's old `Offline` row re-registers on the same port.
    targets([PHONE, staleEmulatorTarget], [PHONE, staleEmulatorTarget], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
    expect(result.note).toBeUndefined();
  });

  it("declines a fresh arrival whose panel is another device's", async () => {
    // A reconnecting foreign device is told apart by its panel.
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
    harmonyDisplay.mockResolvedValue({ width: PANEL.height, height: PANEL.width, screenOn: true });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("says a target was seen and declined rather than that none registered", async () => {
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
    // Without `-v` there is no connection column; the USB exclusion fails open.
    const UNTYPED = { connectKey: "127.0.0.1:5555", connection: null, state: "Connected" };
    targets([PHONE], [PHONE, UNTYPED]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await pending) as { udid: string }).udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses to guess when two targets it could have started both arrive", async () => {
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/two|both|more than one|could not tell which/i);
  });

  it("refuses at once rather than spending the budget on a decision already made", async () => {
    const OTHER_EMULATOR = { connectKey: "127.0.0.1:5557", connection: "TCP", state: "Connected" };
    targets([PHONE], [PHONE, emulatorTarget, OTHER_EMULATOR]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 180_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/More than one/);
  });

  it("keeps refusing after one of the two ambiguous targets drops away", async () => {
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
    // A TCP peer of the same profile passes both the USB and panel filters.
    targets([PHONE, foreignTarget], [PHONE, foreignTarget, emulatorTarget]);

    const result = (await boot({})) as { udid: string };

    expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
  });

  it("refuses rather than starting blind when the pre-start listing cannot be read", async () => {
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("[Fail]Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const assertion = expect(pending).rejects.toThrow(/could not have been told apart/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("takes the snapshot on a retry rather than failing the boot for one bad listing", async () => {
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
    const probes: { at: number; timeoutMs?: number }[] = [];
    harmonyDumpLayout.mockImplementation((_key: unknown, path: string, timeoutMs?: number) => {
      probes.push({ at: Date.now(), timeoutMs });
      writeFileSync(path, "{}");
      return new Promise(() => {}); // never answers, like a guest still coming up
    });
    targets([PHONE], [PHONE, emulatorTarget]);
    vi.useFakeTimers();

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
      expect(probe.at + probe.timeoutMs!).toBeLessThanOrEqual(startedAt + 10_000);
    }
  });

  it("caps the target listing at what is left of the budget too", async () => {
    // Each listing must be capped by what is left of the budget.
    const listings: { at: number; timeoutMs?: number }[] = [];
    listHarmonyHdcTargetsStrict.mockResolvedValueOnce([PHONE]);
    listHarmonyHdcTargetsStrict.mockImplementation((timeoutMs?: number) => {
      listings.push({ at: Date.now(), timeoutMs });
      return new Promise((resolve) => setTimeout(() => resolve([PHONE]), 4_000));
    });
    vi.useFakeTimers();

    const startedAt = Date.now();
    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).resolves.toMatchObject({
      note: expect.stringMatching(/keeps booting/),
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
    listHarmonyInstances
      .mockResolvedValueOnce([
        { name: INSTANCE, deviceType: "Phone", osVersion: null, running: true, display: PANEL },
      ])
      .mockResolvedValue([
        { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false, display: PANEL },
      ]);
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
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          // down, up for the forced boot, down once its stop-wait polls
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
    const stopOrder = runHarmonyEmulator.mock.invocationCallOrder[0]!;
    const startOrder = spawnMock.mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeGreaterThan(startOrder);
  });

  it("clamps the no-connector grace against the boot deadline", async () => {
    resolveHdc.mockResolvedValue(null);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_100);
    const result = (await pending) as { booted: boolean; note?: string };
    expect(result.booted).toBe(true);
  });

  it("gives each boot attempt its own start log", async () => {
    targets([PHONE], [PHONE, emulatorTarget]);
    await boot({});
    targets([PHONE], [PHONE, emulatorTarget]);
    await boot({});

    const paths = harmonyLogs(INSTANCE);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("boots without a log when the temp directory cannot be written", async () => {
    // `/dev/null` is a file, so opening anything beneath it fails.
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
    harmonyDumpLayout.mockImplementation(() => {
      child.die("error: the emulator instance quit unexpectedly (disk image corrupted)");
      return Promise.reject(new Error("DumpLayout failed:Get window nodes failed"));
    });
    targets([PHONE], [PHONE, emulatorTarget]);

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
    listHarmonyInstances.mockResolvedValue([
      { name: INSTANCE, deviceType: "Phone", osVersion: null, running: false, display: null },
    ]);
    // Each listing costs a third of the budget.
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
    expect(result.note).toMatch(/had not answered `uitest`/);
    expect(result.note).toMatch(/no panel on record/);
  });

  it("names the declined target, not the unreadable one, when it saw both", async () => {
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
    // `hdc` answers a dead server with exit 0 and no rows: strict refuses, tolerant says [].
    listHarmonyHdcTargetsStrict.mockResolvedValueOnce([PHONE]);
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("[Fail]Connect server failed"));
    listHarmonyHdcTargets.mockResolvedValue([]);
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc list targets` failed every time/);
    expect(result.note).not.toMatch(/had not registered/);
    expect(result.note).not.toMatch(/bootTimeoutMs/);
  });

  it("carries both caveats when the key is neither checked nor answering", async () => {
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
    expect(result.note).toMatch(/keeps booting/);
  });

  it("blames the missing connector instead of waiting out the budget for it", async () => {
    resolveHdc.mockResolvedValue(null);
    vi.useFakeTimers();

    const pending = boot({});
    // Past the no-`hdc` exit grace, not the boot budget.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = (await pending) as { udid: string; note?: string };

    expect(result.udid).toBe(`harmony-emulator-${INSTANCE}`);
    expect(result.note).toMatch(/`hdc` was not found/);
  });

  it("does not claim the instance started when the manager already died and hdc is missing", async () => {
    // The manager dies while `hdc` is looked up, as in reality.
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
    // Running for 40s, past any fixed grace; the stopped instance keeps an
    // `Offline` row, as on a device.
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

    // The pre-stop lookup is unbounded; the wait rounds are on the clock.
    const waitRounds = listings.slice(1);
    expect(waitRounds.length).toBeGreaterThan(1);
    for (const listing of waitRounds) {
      expect(listing.timeoutMs).toBeGreaterThan(0);
      expect(listing.at + listing.timeoutMs!).toBeLessThanOrEqual(startedAt + 30_000);
    }
    expect(waitRounds.at(-1)!.at).toBeLessThan(startedAt + 30_000);
  });

  it("pays for a `force` restart's stop and snapshot out of the budget, not on top of it", async () => {
    const calls: { at: number; timeoutMs?: number }[] = [];
    runHarmonyEmulator.mockImplementation((args: string[], timeoutMs?: number) => {
      if (args[0] === "-stop") calls.push({ at: Date.now(), timeoutMs });
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    listHarmonyHdcTargetsStrict.mockImplementation((timeoutMs?: number) => {
      calls.push({ at: Date.now(), timeoutMs });
      return new Promise((resolve) => setTimeout(() => resolve([PHONE]), 4_000));
    });
    // Puts the shutdown at 26s of a 30s budget.
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
    expect(getFailureSignal(await pending.catch((e: unknown) => e))).toMatchObject({
      error_code: FAILURE_CODES.BOOT_HARMONY_TARGET_LIST_FAILED,
      failure_command: "hdc",
    });
  });

  it("reports a wedged `hdc` as the timeout its own wrapper classified it as", async () => {
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
    // A plain `Error` carries no signal to inherit.
    listHarmonyHdcTargetsStrict.mockRejectedValue(new Error("Connect server failed"));
    vi.useFakeTimers();

    const pending = boot({ bootTimeoutMs: 30_000 });
    const settled = expect(pending).rejects.toThrow(/Could not read `hdc`'s device table/);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;

    expect(getFailureSignal(await pending.catch((e: unknown) => e))?.error_kind).toBe("subprocess");
  });

  it("stops probing arrivals once the budget is spent, rather than once per arrival", async () => {
    // Three arrivals at 20s each would outlast two budgets.
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

    expect(await elapsed).toBeLessThanOrEqual(30_000);
    expect(((await pending) as { note?: string }).note).toMatch(/registered/);
    // Probes behind the one that spent the budget must never spawn.
    expect(probes.length).toBeGreaterThan(0);
    for (const at of probes) expect(at).toBeLessThan(startedAt + 30_000);
  });

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

      expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
      expect(result.note).toBeUndefined();
    });

    it("does not treat another instance being up as this one already running", async () => {
      listHarmonyInstances.mockResolvedValue(instances({ running: false }, { running: true }));
      targets([PHONE], [PHONE, emulatorTarget]);

      const result = (await boot({})) as { udid: string; note?: string };

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        ["-start", INSTANCE],
        expect.any(Object)
      );
      expect(result.udid).toBe(`harmony-${EMULATOR_KEY}`);
      expect(result.note).toBeUndefined();
    });

    it("waits out only its own instance's shutdown, not another's", async () => {
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
    targets([PHONE], [PHONE, emulatorTarget]);

    const [a, b] = await Promise.all([boot({}), boot({})]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("does not let a `force` boot join a plain one that would skip the restart", async () => {
    let listed = 0;
    listHarmonyInstances.mockImplementation(() =>
      Promise.resolve([
        {
          name: INSTANCE,
          deviceType: "Phone",
          osVersion: null,
          // running for both opening checks, down once the stop-wait polls
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
    const failed = await boot({
      harmonyInstance: `harmony-${PHONE.connectKey}`,
      bootTimeoutMs: 30_000,
    }).catch((e: unknown) => e);

    expect((failed as Error).message).toContain(`"harmony-${PHONE.connectKey}" not found`);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Registry } from "@argent/registry";

// Parametrize platform-dependent assertions so a single CI runner exercises
// both branches. Without this, macOS CI never tests the linux branch and
// linux CI never tests the darwin branch — a regression that swapped them
// would pass on both runners. See selectGpuMode in boot-device.ts.
const PLATFORMS: ReadonlyArray<readonly [NodeJS.Platform, string]> = [
  ["linux", "swiftshader"],
  ["darwin", "auto"],
];
const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const execFileMock = vi.fn();
const spawnMock = vi.fn();
const hasSnapshotMock = vi.fn();
const probeMock = vi.fn();
const supportsFlagMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});

// Stub the filesystem/probe helpers so tests don't depend on a real AVD or a
// real `emulator -check-snapshot-loadable` spawn. `emulatorSupportsFlag` is
// stubbed too: the real one memoizes its `emulator -help` result per binary
// for the lifetime of the process, so tests could not otherwise exercise both
// the supported and unsupported branch in one file.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    hasDefaultBootSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
    checkSnapshotLoadable: (...a: unknown[]) => probeMock(...a),
    emulatorSupportsFlag: (...a: unknown[]) => supportsFlagMock(...a),
  };
});

// `boot-device` now goes through `resolveAndroidBinary` for both ensureDep
// and the spawn path. Stub the resolver to return the bare name so existing
// `cmd === "adb" / "emulator"` and `spawnMock("emulator", ...)` matchers fire
// regardless of host SDK install state.
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import {
  __resetInFlightBootsForTesting,
  createBootDeviceTool,
} from "../src/tools/devices/boot-device";

const registry: Registry = { resolveService: async () => ({}) } as unknown as Registry;

interface FakeChild extends EventEmitter {
  unref: () => void;
  kill: (sig?: string) => void;
  exitCode: number | null;
  signalCode: string | null;
}

function fakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.unref = () => {};
  proc.kill = () => {};
  proc.exitCode = null;
  proc.signalCode = null;
  return proc;
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  hasSnapshotMock.mockReset();
  probeMock.mockReset();
  supportsFlagMock.mockReset();
  // Default to the conservative branch: an emulator build that does not list
  // the flag in `-help`. Tests that need the supported branch opt in.
  supportsFlagMock.mockResolvedValue(false);
  spawnMock.mockImplementation(() => fakeChild());
  // Per-AVD in-flight coalescing carries leaked promises across tests; reset
  // so each test starts with an empty boot map. (See note in adjacent
  // boot-device-hardening.test.ts.)
  __resetInFlightBootsForTesting();
});

afterEach(() => {
  // Restore process.platform after every test, even ones that don't pin it,
  // so a forgotten cleanup in one test can't leak into the next.
  setPlatform(originalPlatform);
});

/**
 * Common happy-path mock: AVD exists, adb is healthy, `adb devices` reveals
 * one new emulator after spawn, wait-for-device succeeds, getprop returns 1,
 * pm path answers. Used to isolate the branch-selection logic under test.
 */
function mockHappyBootChain(newSerial = "emulator-5554") {
  let devicesCalls = 0;
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "emulator" && args[0] === "-list-avds") {
      return { stdout: "Pixel_7_API_34\n", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "version") {
      return { stdout: "Android Debug Bridge\n", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
    if (cmd === "adb" && args[0] === "devices") {
      devicesCalls += 1;
      const emuLine = devicesCalls >= 2 ? `${newSerial}\tdevice\n` : "";
      return { stdout: `List of devices attached\n${emuLine}`, stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device") {
      return { stdout: "", stderr: "" };
    }
    if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
      const shellCmd = args[3] ?? "";
      if (shellCmd.startsWith("getprop sys.boot_completed")) {
        return { stdout: "1\n", stderr: "" };
      }
      if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
      if (shellCmd === "pm path android") {
        return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
      }
      if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
      return { stdout: "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("boot-device Android — hot-boot with cold-boot fallback", () => {
  it.each(PLATFORMS)(
    "picks the hot-boot spawn args + `-gpu %s` on %s when default_boot probes Loadable",
    async (platform, expectedGpu) => {
      setPlatform(platform);
      hasSnapshotMock.mockResolvedValue(true);
      probeMock.mockResolvedValue({ loadable: true, reason: null });
      mockHappyBootChain();

      const tool = createBootDeviceTool(registry);
      const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

      expect(result).toMatchObject({
        platform: "android",
        serial: "emulator-5554",
        avdName: "Pixel_7_API_34",
        booted: true,
      });

      // Exactly one emulator spawn and it is the hot-boot arg set.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const hotArgs = spawnMock.mock.calls[0]![1];
      expect(hotArgs).toContain("-force-snapshot-load");
      expect(hotArgs).toContain("-no-snapshot-save");
      expect(hotArgs).not.toContain("-no-snapshot-load");
      // Window is visible by default — `-no-window` only appears when the
      // user opts in via `ARGENT_EMULATOR_NO_WINDOW`. The opt-in path is
      // exercised by a separate test below.
      expect(hotArgs).not.toContain("-no-window");
      // `-gpu` arg must be present and platform-appropriate. Linux uses
      // `swiftshader` for universal compatibility (sidesteps the host GL
      // stack, which silently fails on Optimus / dual-GPU / Wayland-with-
      // NVIDIA setups); every other host uses `auto`. See `selectGpuMode`.
      const gpuIdx = hotArgs.indexOf("-gpu");
      expect(gpuIdx).toBeGreaterThanOrEqual(0);
      expect(hotArgs[gpuIdx + 1]).toBe(expectedGpu);
    }
  );

  it.each(PLATFORMS)(
    "hands `-gpu %s` to both probe and hot-boot spawn on %s",
    async (platform, expectedGpu) => {
      // Sibling test of the assertion above, focused on parity: the probe
      // argv and the spawn argv must agree on every renderer-affecting flag,
      // or the emulator's `-check-snapshot-loadable` resolves a different
      // renderer than the boot does and rejects perfectly loadable snapshots.
      // The bug this guards against is "every boot is cold on Linux even
      // with a fresh snapshot on disk" — caught only end-to-end because both
      // unit-mocked halves test green in isolation.
      setPlatform(platform);
      hasSnapshotMock.mockResolvedValue(true);
      probeMock.mockResolvedValue({ loadable: true, reason: null });
      mockHappyBootChain();

      const tool = createBootDeviceTool(registry);
      await tool.execute!({}, { avdName: "Pixel_7_API_34" });

      expect(probeMock).toHaveBeenCalledTimes(1);
      const [, , probeOptions] = probeMock.mock.calls[0]!;
      // Renderer args (`-gpu`) AND launch-hardening args (`-noaudio`,
      // `-netfast`) all change qemu device topology — any one of them
      // differing between probe and boot is enough to reject a perfectly
      // loadable snapshot. Assert both halves arrive in the probe's extraArgs
      // so the parity test catches a regression in either group.
      expect(probeOptions).toMatchObject({
        extraArgs: expect.arrayContaining(["-gpu", expectedGpu, "-noaudio", "-netfast"]),
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const hotArgs = spawnMock.mock.calls[0]![1] as string[];
      const gpuIdx = hotArgs.indexOf("-gpu");
      expect(gpuIdx).toBeGreaterThanOrEqual(0);
      expect(hotArgs[gpuIdx + 1]).toBe(expectedGpu);
    }
  );

  it("passes launch-hardening flags on the hot-boot spawn", async () => {
    // `-noaudio`, `-no-boot-anim`, `-netfast` are the perf cuts; `-no-metrics`
    // suppresses the metrics consent dialog that blocks MCP-driven boots on
    // first run. All four must reach the spawn or argent loses the qemu device
    // parity the probe relies on (and the dialog protection). See
    // LAUNCH_HARDENING_ARGS in boot-device.ts for the per-flag rationale.
    // (`-crash-report-mode never` is feature-detected, not unconditional —
    // covered by the dedicated describe block below.)
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const hotArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(hotArgs).toEqual(
      expect.arrayContaining(["-noaudio", "-no-boot-anim", "-netfast", "-no-metrics"])
    );
  });

  it("passes the same launch-hardening flags on the cold-boot spawn", async () => {
    // Cold boot WRITES a snapshot (no `-no-snapshot-save`); the next hot boot
    // reads it. If cold-boot's qemu config differs from hot-boot's, the saved
    // snapshot is unloadable and argent re-enters cold-boot forever.
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const coldArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(coldArgs).toEqual(
      expect.arrayContaining(["-noaudio", "-no-boot-anim", "-netfast", "-no-metrics"])
    );
  });

  it("honors ARGENT_EMULATOR_GPU_MODE env override", async () => {
    // Escape hatch for power users with verified-working `-gpu host`.
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const prev = process.env.ARGENT_EMULATOR_GPU_MODE;
    process.env.ARGENT_EMULATOR_GPU_MODE = "host";
    try {
      const tool = createBootDeviceTool(registry);
      await tool.execute!({}, { avdName: "Pixel_7_API_34" });
      const args = spawnMock.mock.calls[0]![1];
      const gpuIdx = args.indexOf("-gpu");
      expect(args[gpuIdx + 1]).toBe("host");
    } finally {
      if (prev === undefined) delete process.env.ARGENT_EMULATOR_GPU_MODE;
      else process.env.ARGENT_EMULATOR_GPU_MODE = prev;
    }
  });

  it("appends -no-window when ARGENT_EMULATOR_NO_WINDOW is set", async () => {
    // Opt-in for CI / containers / Wayland-only sessions where the emulator
    // can't open a Qt window. See selectExtraEmulatorArgs.
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const prev = process.env.ARGENT_EMULATOR_NO_WINDOW;
    process.env.ARGENT_EMULATOR_NO_WINDOW = "1";
    try {
      const tool = createBootDeviceTool(registry);
      await tool.execute!({}, { avdName: "Pixel_7_API_34" });
      const args = spawnMock.mock.calls[0]![1];
      expect(args).toContain("-no-window");
    } finally {
      if (prev === undefined) delete process.env.ARGENT_EMULATOR_NO_WINDOW;
      else process.env.ARGENT_EMULATOR_NO_WINDOW = prev;
    }
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["false", "false"],
    ["no", "no"],
  ])("treats ARGENT_EMULATOR_NO_WINDOW=%s as off", async (_label, value) => {
    // `export FOO=` is a common shell mis-setting; `0`/`false`/`no` all
    // read as "disable" — only `1`, `true`, `yes` activate -no-window.
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const prev = process.env.ARGENT_EMULATOR_NO_WINDOW;
    process.env.ARGENT_EMULATOR_NO_WINDOW = value;
    try {
      const tool = createBootDeviceTool(registry);
      await tool.execute!({}, { avdName: "Pixel_7_API_34" });
      const args = spawnMock.mock.calls[0]![1];
      expect(args).not.toContain("-no-window");
    } finally {
      if (prev === undefined) delete process.env.ARGENT_EMULATOR_NO_WINDOW;
      else process.env.ARGENT_EMULATOR_NO_WINDOW = prev;
    }
  });

  it.each(PLATFORMS)(
    "ignores empty/whitespace ARGENT_EMULATOR_GPU_MODE, falls through to `%s` default on %s",
    async (platform, expectedGpu) => {
      // `export FOO=` foot-gun: fall through to platform default, don't crash.
      setPlatform(platform);
      hasSnapshotMock.mockResolvedValue(false);
      mockHappyBootChain();

      const prev = process.env.ARGENT_EMULATOR_GPU_MODE;
      process.env.ARGENT_EMULATOR_GPU_MODE = "   ";
      try {
        const tool = createBootDeviceTool(registry);
        await tool.execute!({}, { avdName: "Pixel_7_API_34" });
        const args = spawnMock.mock.calls[0]![1];
        const gpuIdx = args.indexOf("-gpu");
        expect(args[gpuIdx + 1]).toBe(expectedGpu);
      } finally {
        if (prev === undefined) delete process.env.ARGENT_EMULATOR_GPU_MODE;
        else process.env.ARGENT_EMULATOR_GPU_MODE = prev;
      }
    }
  );

  it("throws on an unknown ARGENT_EMULATOR_GPU_MODE rather than letting emulator -gpu fail later", async () => {
    // A typoed override (`ARGENT_EMULATOR_GPU_MODE=hsot`) used to be passed
    // through verbatim and the emulator binary rejected it mid-launch — that
    // path burns the full hot-boot budget before surfacing the error. We
    // validate against the whitelist at boot-start so the user sees the
    // mistake immediately.
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();
    const prev = process.env.ARGENT_EMULATOR_GPU_MODE;
    process.env.ARGENT_EMULATOR_GPU_MODE = "hsot";
    try {
      const tool = createBootDeviceTool(registry);
      await expect(tool.execute!({}, { avdName: "Pixel_7_API_34" })).rejects.toThrow(
        /ARGENT_EMULATOR_GPU_MODE=.*not a known emulator -gpu value/
      );
    } finally {
      if (prev === undefined) delete process.env.ARGENT_EMULATOR_GPU_MODE;
      else process.env.ARGENT_EMULATOR_GPU_MODE = prev;
    }
  });

  it.each(PLATFORMS)(
    "skips hot-boot and cold-boots with `-gpu %s` on %s when no snapshot exists",
    async (platform, expectedGpu) => {
      setPlatform(platform);
      hasSnapshotMock.mockResolvedValue(false);
      mockHappyBootChain();

      const tool = createBootDeviceTool(registry);
      await tool.execute!({}, { avdName: "Pixel_7_API_34" });

      expect(probeMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const args = spawnMock.mock.calls[0]![1];
      expect(args).toContain("-no-snapshot-load");
      expect(args).not.toContain("-force-snapshot-load");
      expect(args).not.toContain("-no-window");
      // Cold boot must also pass the platform-appropriate `-gpu` value so the
      // snapshot it eventually saves matches the renderer the next launch's
      // probe will resolve. Without this, the cold-boot fallback bakes a
      // renderer mismatch into the saved snapshot and re-enters the "every
      // boot is cold" cycle.
      expect(args).toEqual(expect.arrayContaining(["-gpu", expectedGpu]));
    }
  );

  it("skips the hot-boot attempt and cold-boots when -check-snapshot-loadable rejects", async () => {
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: false, reason: "different renderer configured" });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    // One spawn, and it is cold-boot args (no -force-snapshot-load).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
  });

  it("throws after cold boot when SurfaceFlinger never composites a real frame", async () => {
    // Cold-boot post-condition: under Linux + Weston-headless + SwiftShader
    // the lockscreen composite lags sys.boot_completed by 5–60 s. boot-device
    // must not return `booted:true` until `screencap` reports at least one
    // non-zero pixel byte, else callers chaining boot → screenshot get a
    // silent all-black PNG. Here we keep screencap stuck on "0" forever and
    // assert the cold-boot path eventually surfaces the timeout instead of
    // returning a serial whose screenshots would all be blank.
    vi.useFakeTimers();
    try {
      hasSnapshotMock.mockResolvedValue(false);
      let devicesCalls = 0;
      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (cmd === "adb" && args[0] === "version")
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          devicesCalls += 1;
          const emuLine = devicesCalls >= 2 ? "emulator-5554\tdevice\n" : "";
          return { stdout: `List of devices attached\n${emuLine}`, stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
          return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
          const shellCmd = args[3] ?? "";
          if (shellCmd.startsWith("getprop sys.boot_completed"))
            return { stdout: "1\n", stderr: "" };
          if (shellCmd === "pm path android")
            return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
          if (shellCmd.startsWith("screencap")) return { stdout: "0\n", stderr: "" };
          return { stdout: "\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const tool = createBootDeviceTool(registry);
      const resultP = tool.execute!({}, { avdName: "Pixel_7_API_34" }).then(
        (v) => ({ ok: true, value: v }) as const,
        (e) => ({ ok: false, error: e as Error }) as const
      );
      // 90 s firstRealFrame budget + the cold-boot stages all park on
      // setTimeout. 200 s of fake time is ample to drain the deadline.
      await vi.advanceTimersByTimeAsync(200_000);
      const outcome = await resultP;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.message).toMatch(/SurfaceFlinger did not composite a real frame/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to cold boot when hot-boot child exits early (ram.bin corruption class)", async () => {
    // Fake timers: the impl parks the stage-2 adb-register loop on a real
    // 1s setTimeout while it waits for the hot child to crash. Driving it
    // with fake timers keeps the behavior identical (crash at 10ms, loop
    // observes earlyExitError, falls back to cold boot) but collapses ~1s of
    // real wall time. adb is module-mocked above, so the only async left is
    // microtasks + the faked timers — fully deterministic.
    vi.useFakeTimers();
    try {
      hasSnapshotMock.mockResolvedValue(true);
      probeMock.mockResolvedValue({ loadable: true, reason: null });
      // First spawn crashes immediately. Second spawn is healthy.
      let spawnCount = 0;
      spawnMock.mockImplementation(() => {
        const child = fakeChild();
        spawnCount += 1;
        if (spawnCount === 1) {
          setTimeout(() => child.emit("exit", 134, null), 10);
        }
        return child;
      });

      // Device-list mock must be spawn-aware: while the first (crashing) hot
      // attempt is in flight, `adb devices` shows no new emulator so the inner
      // boot loop stays in the wait and observes earlyExitError. Once the
      // second (cold) spawn happens, the new serial appears.
      let coldSerialVisible = false;
      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (cmd === "adb" && args[0] === "version")
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          if (spawnCount >= 2) coldSerialVisible = true;
          const line = coldSerialVisible ? "emulator-5554\tdevice\n" : "";
          return { stdout: `List of devices attached\n${line}`, stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device") {
          return { stdout: "", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
          const shellCmd = args[3] ?? "";
          if (shellCmd.startsWith("getprop sys.boot_completed"))
            return { stdout: "1\n", stderr: "" };
          if (shellCmd === "pm path android")
            return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
          if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
          return { stdout: "\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const tool = createBootDeviceTool(registry);
      const resultP = tool.execute!({}, { avdName: "Pixel_7_API_34" });
      // t=10 hot child crashes; t=1000 the stage-2 poll wakes, sees the
      // earlyExitError and falls back to cold boot (which then resolves fast
      // since the serial is immediately visible). 5s of fake time is ample.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultP;

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
      expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
      expect(spawnMock.mock.calls[1]![1]).not.toContain("-force-snapshot-load");
      expect(result).toMatchObject({ serial: "emulator-5554" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to cold boot when hot-restore leaves screencap returning a blank frame", async () => {
    // assertScreencapAlive polls within firstRealFrameHot (8 s) before
    // declaring a sticky-blank state — uses fake timers so we don't wall-clock
    // through the budget. Without this the test would real-time wait 8 s.
    vi.useFakeTimers();
    try {
      hasSnapshotMock.mockResolvedValue(true);
      probeMock.mockResolvedValue({ loadable: true, reason: null });

      // First spawn (hot) boots cleanly but screencap returns a blank frame —
      // the SurfaceFlinger composite-restore artefact. Second spawn (cold) is
      // fully healthy. Each spawn registers a distinct serial so the cold-boot
      // poll picks up a genuinely new emulator.
      let spawnCount = 0;
      spawnMock.mockImplementation(() => {
        spawnCount += 1;
        return fakeChild();
      });

      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "emulator" && args[0] === "-list-avds")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (cmd === "adb" && args[0] === "version")
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          let lines = "";
          if (spawnCount >= 1) lines += "emulator-5554\tdevice\n";
          if (spawnCount >= 2) lines += "emulator-5556\tdevice\n";
          return { stdout: `List of devices attached\n${lines}`, stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
          return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
          const serial = args[1];
          const shellCmd = args[3] ?? "";
          if (shellCmd.startsWith("getprop sys.boot_completed"))
            return { stdout: "1\n", stderr: "" };
          if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
          if (shellCmd === "pm path android")
            return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
          if (shellCmd.startsWith("screencap")) {
            return { stdout: serial === "emulator-5554" ? "0\n" : "1\n", stderr: "" };
          }
          return { stdout: "\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const tool = createBootDeviceTool(registry);
      const resultP = tool.execute!({}, { avdName: "Pixel_7_API_34" });
      // Drain the 8 s polling budget + a margin for the post-fail cold-boot
      // chain (also parks on setTimeout).
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultP;

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[0]![1]).toContain("-force-snapshot-load");
      expect(spawnMock.mock.calls[1]![1]).toContain("-no-snapshot-load");
      expect(result).toMatchObject({ serial: "emulator-5556" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the already-running emulator without spawning when the AVD is live and its framebuffer is healthy", async () => {
    // adb devices reports the AVD already attached; getprop answers with the
    // matching AVD name. screencap returns a healthy frame ("1") so the
    // wedged-framebuffer guard passes. No snapshot probe, no spawn.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd === "getprop ro.boot.qemu.avd_name")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    const result = await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(result).toMatchObject({
      platform: "android",
      serial: "emulator-5554",
      avdName: "Pixel_7_API_34",
      booted: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(hasSnapshotMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("kills the running AVD and respawns when its framebuffer is wedged on the reuse path", async () => {
    // The fast-path's BUG GUARD: if a long-running emulator drifts into the
    // sticky-blank screencap state, returning that serial unchanged would
    // hand the caller a device whose screenshots are silently all-zero.
    // The guard kills the wedged emulator and falls through to a fresh boot.
    // Fake timers: assertScreencapAlive polls for firstRealFrameHot (8 s)
    // before declaring a wedge, then the cold-boot fallback parks on its own
    // setTimeout cadence. Without fake timers this would real-time wait.
    vi.useFakeTimers();
    try {
      hasSnapshotMock.mockResolvedValue(false); // force the cold-boot path post-kill
      let killed = false;
      let spawned = false;
      spawnMock.mockImplementation(() => {
        spawned = true;
        return fakeChild();
      });
      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "adb" && args[0] === "version")
          return { stdout: "Android Debug Bridge\n", stderr: "" };
        if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
        if (cmd === "emulator" && args[0] === "-list-avds")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (cmd === "adb" && args[0] === "devices") {
          // Pre-kill: wedged emulator-5554 is listed. After kill but before
          // the cold-boot spawn registers: empty (so emulator-5556 is *new*
          // when it appears). Post-spawn: emulator-5556 is listed.
          let line = "";
          if (!killed) line = "emulator-5554\tdevice\n";
          else if (spawned) line = "emulator-5556\tdevice\n";
          return { stdout: `List of devices attached\n${line}`, stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
          return { stdout: "", stderr: "" };
        if (cmd === "adb" && args[0] === "-s" && args.includes("emu") && args.includes("kill")) {
          killed = true;
          return { stdout: "OK\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
          const serial = args[1];
          const shellCmd = args[3] ?? "";
          if (shellCmd === "getprop ro.boot.qemu.avd_name")
            return { stdout: "Pixel_7_API_34\n", stderr: "" };
          if (shellCmd.startsWith("getprop sys.boot_completed"))
            return { stdout: "1\n", stderr: "" };
          if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
          if (shellCmd === "pm path android")
            return { stdout: "package:/system/framework/framework-res.apk\n", stderr: "" };
          if (shellCmd.startsWith("screencap")) {
            // Wedged frame on the original serial; healthy on the respawn.
            return { stdout: serial === "emulator-5554" ? "0\n" : "1\n", stderr: "" };
          }
        }
        return { stdout: "", stderr: "" };
      });

      const tool = createBootDeviceTool(registry);
      const resultP = tool.execute!({}, { avdName: "Pixel_7_API_34" });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultP;

      expect(killed).toBe(true);
      // Exactly one fresh spawn (the cold-boot fallback after the kill).
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
      expect(result).toMatchObject({ serial: "emulator-5556" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the cold-booted emulator as booted when PackageManager stays slow on the final attempt (does not tear it down)", async () => {
    // Regression: a slow-but-alive guest (pm never answers within the probe
    // window even though sys.boot_completed=1 and adb registered the serial)
    // must NOT be torn down on the final cold attempt — there is no fallback
    // left and the device is usable via gRPC. Previously a single 10 s pm
    // probe failure killed the emulator and failed the whole boot.
    hasSnapshotMock.mockResolvedValue(false); // skip hot boot -> straight to cold
    let killed = false;
    let devicesCalls = 0;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        devicesCalls += 1;
        const emuLine = devicesCalls >= 2 ? "emulator-5554\tdevice\n" : "";
        return { stdout: `List of devices attached\n${emuLine}`, stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "wait-for-device")
        return { stdout: "", stderr: "" };
      if (cmd === "adb" && args[0] === "-s" && args.includes("emu") && args.includes("kill")) {
        killed = true;
        return { stdout: "OK\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd.startsWith("getprop sys.boot_completed")) return { stdout: "1\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        // pm never answers — simulate the adb call being SIGKILLed on timeout.
        if (shellCmd === "pm path android")
          return new Error(
            "Command failed: adb -s emulator-5554 shell pm path (killed=true signal=SIGKILL)"
          );
        // screencap returns a real (non-zero) frame so awaitFirstRealFrame passes.
        if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
        return { stdout: "\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    vi.useFakeTimers();
    try {
      const tool = createBootDeviceTool(registry);
      const resultP = tool.execute!({}, { avdName: "Pixel_7_API_34" });
      // Drive past the ~45 s PM-probe retry budget instantly. The guest is
      // alive (screencap returns a real frame, so awaitFirstRealFrame passes),
      // so the final cold attempt returns it as booted instead of killing it.
      await vi.advanceTimersByTimeAsync(50_000);
      const result = await resultP;

      expect(result).toMatchObject({
        platform: "android",
        serial: "emulator-5554",
        booted: true,
      });
      // The healthy-but-slow guest must be left running, not killed.
      expect(killed).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]![1]).toContain("-no-snapshot-load");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("boot-device Android — `-crash-report-mode` feature gate", () => {
  // Regression: `-crash-report-mode` was added to LAUNCH_HARDENING_ARGS (so it
  // shipped on every launch) AND, later, behind an `emulatorSupportsFlag`
  // gate — the gate never took effect. On emulator builds whose `-help` does
  // not list the flag (verified on 36.1.9.0) the launch aborts with
  // "unknown option: -crash-report-mode" and boot-device fails outright; on
  // builds that do accept it the flag was passed twice. Assert the exact
  // occurrence COUNT, not mere presence: presence alone passes on the
  // double-pass code and would guard nothing.
  const FLAG = "-crash-report-mode";
  const countFlag = (argv: readonly string[]) => argv.filter((a) => a === FLAG).length;

  /** Assert the flag appears exactly `times` times and always as `<flag> never`. */
  function expectFlagOccurrences(argv: readonly string[], times: number) {
    expect(countFlag(argv)).toBe(times);
    argv.forEach((arg, i) => {
      if (arg === FLAG) expect(argv[i + 1]).toBe("never");
    });
  }

  it("omits the flag from the snapshot probe and the hot-boot spawn when the emulator rejects it", async () => {
    supportsFlagMock.mockResolvedValue(false);
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(probeMock).toHaveBeenCalledTimes(1);
    const probeArgs = (probeMock.mock.calls[0]![2] as { extraArgs: string[] }).extraArgs;
    expectFlagOccurrences(probeArgs, 0);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFlagOccurrences(spawnMock.mock.calls[0]![1] as string[], 0);
  });

  it("omits the flag from the cold-boot spawn when the emulator rejects it", async () => {
    supportsFlagMock.mockResolvedValue(false);
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const coldArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(coldArgs).toContain("-no-snapshot-load");
    expectFlagOccurrences(coldArgs, 0);
  });

  it("passes the flag exactly once to the snapshot probe and the hot-boot spawn when supported", async () => {
    supportsFlagMock.mockResolvedValue(true);
    hasSnapshotMock.mockResolvedValue(true);
    probeMock.mockResolvedValue({ loadable: true, reason: null });
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(supportsFlagMock).toHaveBeenCalledWith(FLAG);

    // The probe must carry it too: it changes emulator startup config, and the
    // probe/boot argv have to agree or a loadable snapshot gets rejected.
    expect(probeMock).toHaveBeenCalledTimes(1);
    const probeArgs = (probeMock.mock.calls[0]![2] as { extraArgs: string[] }).extraArgs;
    expectFlagOccurrences(probeArgs, 1);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFlagOccurrences(spawnMock.mock.calls[0]![1] as string[], 1);
  });

  it("passes the flag exactly once to the cold-boot spawn when supported", async () => {
    supportsFlagMock.mockResolvedValue(true);
    hasSnapshotMock.mockResolvedValue(false);
    mockHappyBootChain();

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const coldArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(coldArgs).toContain("-no-snapshot-load");
    expectFlagOccurrences(coldArgs, 1);
  });

  it("skips the `-help` feature probe entirely when an already-running AVD is reused", async () => {
    // The detection costs an `emulator -help` spawn; the reuse fast-path never
    // launches an emulator, so it must return before the probe runs.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "version")
        return { stdout: "Android Debug Bridge\n", stderr: "" };
      if (cmd === "adb" && args[0] === "start-server") return { stdout: "", stderr: "" };
      if (cmd === "emulator" && args[0] === "-list-avds")
        return { stdout: "Pixel_7_API_34\n", stderr: "" };
      if (cmd === "adb" && args[0] === "devices")
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd === "getprop ro.boot.qemu.avd_name")
          return { stdout: "Pixel_7_API_34\n", stderr: "" };
        if (shellCmd.startsWith("getprop")) return { stdout: "unknown\n", stderr: "" };
        if (shellCmd.startsWith("screencap")) return { stdout: "1\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createBootDeviceTool(registry);
    await tool.execute!({}, { avdName: "Pixel_7_API_34" });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(supportsFlagMock).not.toHaveBeenCalled();
  });
});

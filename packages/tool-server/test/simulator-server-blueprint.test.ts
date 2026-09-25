import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { getFailureSignal, type DeviceInfo } from "@argent/registry";
import { toSimulatorNetworkError } from "../src/utils/format-error";

// ─── Mocks ───────────────────────────────────────────────────────────
//
// We mock at the module-boundary layer so the real blueprint factory runs —
// this is a repro of the dispatch and stdio behaviour, not a shape check.
// If any of these are quietly regressed, hands-on Android sessions will start
// failing before this test does, so the assertions below are deliberately
// specific (argv, stdio).

const spawnMock = vi.fn();
const ensureAutomationEnabledMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../src/blueprints/ax-service", () => ({
  ensureAutomationEnabled: (...args: unknown[]) => ensureAutomationEnabledMock(...args),
}));

// `android.sdkRoot` reaches the binary as ANDROID_HOME; stub the config read
// so the dev's own config.json cannot leak into the spawn assertions.
const androidSdkRootMock = vi.fn((): string | null => null);
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAndroidSdkRoot: () => androidSdkRootMock() };
});

vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => "/fake/bin/simulator-server",
  simulatorServerRunDir: () => "/fake/bin",
}));

// The factory now probes the runtime kind to reject tvOS sims. Mock it to the
// iOS path (false) so these spawn/stdio tests stay hermetic — no real `simctl`,
// which would otherwise hang the fake-timer test waiting on a child process.
const isFoldableSimulatorMock = vi.fn(async (_udid: string) => false);
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
  // A foldable's factory probes the server for its panels; every case here is
  // a plain device unless it flips this.
  isFoldableSimulator: (udid: string) => isFoldableSimulatorMock(udid),
}));

// Device-set resolution reads the user's config + probes simctl — mock it to
// the default set (null) so spawns stay hermetic; the additional-set spawn
// test flips it per-case.
const deviceSetForUdidMock = vi.fn(async (_udid: string): Promise<string | null> => null);
vi.mock("../src/utils/ios-device-sets", () => ({
  deviceSetForUdid: (udid: string) => deviceSetForUdidMock(udid),
}));

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = { write: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

/**
 * Push the readiness lines into stdout so readline's line events fire and the
 * blueprint resolves. We push on nextTick so the blueprint has time to attach
 * its listener after calling `spawn`.
 *
 * A real streaming simulator-server prints `stream_ready` BEFORE `api_ready`
 * (see the comment in spawnSimulatorServerProcess). Emitting both — in that
 * order — lets the blueprint resolve immediately. Emitting only `api_ready`
 * (the old behavior) forced every test to wait out the full STREAM_GRACE_MS
 * non-streaming fallback window, adding ~500ms of dead time per test. The
 * grace-window fallback itself is covered explicitly, with fake timers, by
 * the dedicated non-streaming test below.
 */
function signalReady(proc: ReturnType<typeof makeFakeProc>, port: number) {
  setImmediate(() => {
    proc.stdout.push(`stream_ready http://127.0.0.1:${port + 1}\n`);
    proc.stdout.push(`api_ready http://127.0.0.1:${port}\n`);
  });
}

function iosDevice(udid: string): DeviceInfo {
  return { id: udid, platform: "ios", kind: "simulator" };
}

function androidDevice(serial: string): DeviceInfo {
  return { id: serial, platform: "android", kind: "emulator" };
}

describe("simulatorServerBlueprint.factory — receives a pre-resolved DeviceInfo", () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    androidSdkRootMock.mockReturnValue(null);
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
    isFoldableSimulatorMock.mockReset().mockResolvedValue(false);
    // Pre-warm the dep cache so the Android branch's `ensureDep('adb')` doesn't
    // shell out to `command -v adb` — CI Linux runners don't have adb on PATH
    // and the real probe would surface as a DependencyMissingError unrelated
    // to the dispatch behaviour under test. Lazy-imported so check-deps.ts
    // loads after the hoisted vi.mock factories have spawnMock initialised.
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns the `ios` subcommand for an iOS device", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    // Late import — the mocks are active at module-load time.
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const udid = "11111111-2222-3333-4444-555555555555";
    const device = iosDevice(udid);
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55555);
    const instance = await factoryPromise;

    // Contract under test:
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, opts] = spawnMock.mock.calls[0]!;
    expect(binary).toBe("/fake/bin/simulator-server");
    expect(args).toEqual(["ios", "--id", udid]);
    // stdin must stay open — the server treats EOF on stdin as a shutdown signal.
    // We verified this hands-on; if this regresses the server silently exits
    // as soon as the tool-server pipes /dev/null.
    expect(opts?.stdio).toEqual(["pipe", "pipe", "pipe"]);

    expect(instance.api.apiUrl).toBe("http://127.0.0.1:55555");
    expect(typeof instance.api.pressKey).toBe("function");

    await instance.dispose();
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
  });

  it("passes --device-set for an iOS device from an additional CoreSimulator set", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const radonSet = "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS";
    deviceSetForUdidMock.mockResolvedValueOnce(radonSet);

    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const device = iosDevice(udid);
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55556);
    const instance = await factoryPromise;

    const [, args] = spawnMock.mock.calls[0]!;
    // Same flag Radon IDE passes to this binary for its own set's devices.
    expect(args).toEqual(["ios", "--id", udid, "--device-set", radonSet]);

    await instance.dispose();
  });

  it("spawns the `android` subcommand for an Android device", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const serial = "emulator-5554";
    const device = androidDevice(serial);
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55556);
    await factoryPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["android", "--id", serial]);
    // No configured SDK root: the child inherits the environment untouched.
    expect(spawnMock.mock.calls[0]![2]).not.toHaveProperty("env");
  });

  it("passes a configured android.sdkRoot to the simulator-server as ANDROID_HOME", async () => {
    androidSdkRootMock.mockReturnValue("/nix/store/android-sdk");
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55561);
    await factoryPromise;

    expect(spawnMock.mock.calls[0]![2]).toMatchObject({
      env: expect.objectContaining({ ANDROID_HOME: "/nix/store/android-sdk" }),
    });
  });

  it("spawns the `android_device` subcommand for a physical Android device", async () => {
    // A physical phone (kind 'device') is driven by a different simulator-server
    // controller than an emulator — the screen-sharing-agent path. The blueprint
    // selects it by kind, so the rest of the tool surface stays identical.
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const serial = "HT82A0203045";
    const device: DeviceInfo = { id: serial, platform: "android", kind: "device" };
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55559);
    await factoryPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["android_device", "--id", serial]);
    // The binary resolves resources/android relative to cwd — must be the run dir.
    expect(spawnMock.mock.calls[0]![2]).toMatchObject({ cwd: "/fake/bin" });
  });

  it("trusts the supplied DeviceInfo and does not reclassify the id", async () => {
    // Single-source-of-truth: the blueprint must not run resolveDevice itself.
    // If a caller passes an Android device whose id happens to look like an
    // iOS UDID, the factory honors the platform on the DeviceInfo and routes
    // to the `android` subcommand — not the `ios` one a shape heuristic would
    // have picked.
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const idShapedLikeIos = "11111111-2222-3333-4444-555555555555";
    const device: DeviceInfo = { id: idShapedLikeIos, platform: "android", kind: "emulator" };
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55557);
    await factoryPromise;

    expect(spawnMock.mock.calls[0]![1]![0]).toBe("android");
  });

  it("pressKey writes the shared stdin command protocol regardless of platform", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55558);
    const instance = await factoryPromise;

    await instance.api.pressKey("Down", 0x29);
    await instance.api.pressKey("Up", 0x29);

    expect(fakeProc.stdin.write).toHaveBeenNthCalledWith(1, "key Down 41\n");
    expect(fakeProc.stdin.write).toHaveBeenNthCalledWith(2, "key Up 41\n");
  });

  it("rejects when the caller forgets to pass DeviceInfo via options", async () => {
    // Defensive: without a device, the factory has no way to decide ios vs
    // android (and that's intentional — the SOT now lives upstream). Surface a
    // clear actionable error instead of silently using a default.
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const stub: DeviceInfo = { id: "ignored", platform: "ios", kind: "simulator" };

    await expect(simulatorServerBlueprint.factory({}, stub)).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  // Regression: this read the literal "simulator-server exited with code before
  // becoming ready" — no code, and the binary's own explanation went only to
  // the tool-server's log, so the failing tool call never said why.
  it("names the exit code and the binary's error when it exits before becoming ready", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    setImmediate(() => {
      fakeProc.stderr.push(
        "[2026-09-23T16:23:35Z INFO  simulator_server::media_handler::screenshot_service] Screenshot service stopped\n"
      );
      fakeProc.stderr.push("Error: Failed to find any running emulator\n");
      // `exit` can fire before stderr drains; the reason must still make it in.
      fakeProc.emit("exit", 1, null);
      setImmediate(() => fakeProc.stderr.push(null));
    });

    const error = (await factoryPromise.catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^simulator-server exited with code 1 before becoming ready/);
    expect(error.message).toContain("Error: Failed to find any running emulator");
    expect(error.message).not.toContain("Screenshot service stopped");
    expect(getFailureSignal(error)).toMatchObject({
      error_code: "SIMULATOR_SERVER_READY_EXITED",
      failure_exit_code: 1,
    });
  });

  it("names the signal when simulator-server is killed before becoming ready", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    setImmediate(() => {
      fakeProc.stderr.push(null);
      fakeProc.emit("exit", null, "SIGKILL");
    });

    const error = (await factoryPromise.catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("simulator-server was killed by SIGKILL before becoming ready");
    expect(getFailureSignal(error)).toMatchObject({
      error_code: "SIMULATOR_SERVER_READY_EXITED",
      failure_signal: "SIGKILL",
    });
  });

  it("keeps the binary's error when routine shutdown lines follow it", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    setImmediate(() => {
      fakeProc.stderr.push("Error: Failed to find any running emulator\n");
      for (let i = 0; i < 12; i++) {
        fakeProc.stderr.push(
          `[2026-09-23T16:23:35Z INFO  simulator_server::media_handler] shutdown step ${i}\n`
        );
      }
      fakeProc.stderr.push(null);
      fakeProc.emit("exit", 1, null);
    });

    const error = (await factoryPromise.catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("Error: Failed to find any running emulator");
    expect(error.message).not.toContain("shutdown step");
  });

  // Stdio can outlive `exit`, so readiness lines may still be buffered while the
  // rejection waits for stderr. A process that already exited is never ready.
  it("never resolves readiness after the process has exited", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    setImmediate(() => {
      fakeProc.emit("exit", 1, null);
      fakeProc.stdout.push("stream_ready http://127.0.0.1:55571\n");
      fakeProc.stdout.push("api_ready http://127.0.0.1:55570\n");
      setImmediate(() => fakeProc.stderr.push(null));
    });

    const error = (await factoryPromise.catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^simulator-server exited with code 1 before becoming ready/);
  });

  it("reports the exit, not the ready timeout, when the process exits just before the deadline", async () => {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    vi.useFakeTimers();
    try {
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const device = androidDevice("emulator-5554");
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
      const settled = factoryPromise.catch((e: unknown) => e);

      // Exit 100 ms before the 30 s readiness deadline, with stderr still open,
      // so the deadline falls inside the wait for stderr to drain.
      await vi.advanceTimersByTimeAsync(29_900);
      fakeProc.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(300);

      const error = (await settled) as Error;
      expect(getFailureSignal(error)).toMatchObject({
        error_code: "SIMULATOR_SERVER_READY_EXITED",
        failure_exit_code: 1,
      });
      expect(fakeProc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the STREAM_GRACE_MS resolve when only api_ready arrives (non-streaming build)", async () => {
    // Non-streaming / older simulator-server builds never print `stream_ready`.
    // The blueprint must still resolve, after a bounded grace window, with an
    // empty streamUrl. Fake timers prove the timing deterministically instead
    // of burning ~500ms of real wall time (this is exactly the cost the other
    // tests used to pay implicitly before signalReady emitted stream_ready).
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    vi.useFakeTimers();
    try {
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      const device = iosDevice("99999999-8888-7777-6666-555555555555");
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });

      let resolved = false;
      void factoryPromise.then(() => {
        resolved = true;
      });

      // Only api_ready — no stream_ready ever arrives.
      fakeProc.stdout.push("api_ready http://127.0.0.1:60000\n");

      // Settle the readline pipeline so the blueprint arms its grace timer,
      // then confirm it is still waiting well inside the grace window.
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(false);

      // Crossing STREAM_GRACE_MS resolves it — with no stream URL.
      await vi.advanceTimersByTimeAsync(600);
      const instance = await factoryPromise;
      expect(resolved).toBe(true);
      expect(instance.api.apiUrl).toBe("http://127.0.0.1:60000");
      expect(instance.api.streamUrl).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("simulatorServerBlueprint.recoverable — self-heal a wedged sim-server", () => {
  const apiUrl = "http://127.0.0.1:58710";

  // Mirror what `fetch()` throws so the classifier walks the real cause chain:
  // a `TypeError: fetch failed` wrapping the low-level connect error.
  function fetchError(causeMessage: string, name = "TypeError"): Error {
    const cause = new Error(causeMessage);
    const err = new Error("fetch failed", { cause });
    err.name = name;
    return err;
  }

  it("recovers on ECONNREFUSED — the un-booted-simulator symptom", async () => {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const err = toSimulatorNetworkError(
      "Screenshot",
      fetchError("connect ECONNREFUSED 127.0.0.1:58710"),
      apiUrl
    );
    expect(simulatorServerBlueprint.recoverable!(err)).toBe(true);
  });

  it("does NOT recover on a reset — the request may have taken effect", async () => {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const err = toSimulatorNetworkError("Screenshot", fetchError("read ECONNRESET"), apiUrl);
    expect(simulatorServerBlueprint.recoverable!(err)).toBe(false);
  });

  it("does NOT recover on a timeout — a hung-but-listening server won't be fixed by respawning", async () => {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const err = toSimulatorNetworkError(
      "Screenshot",
      fetchError("The operation was aborted", "AbortError"),
      apiUrl
    );
    expect(simulatorServerBlueprint.recoverable!(err)).toBe(false);
  });

  it("does NOT recover on an unrelated error carrying no failure signal", async () => {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    expect(simulatorServerBlueprint.recoverable!(new Error("boom"))).toBe(false);
  });
});

describe("simulatorServerBlueprint.factory — a foldable simulator's panels", () => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  const PANELS = [
    { screenId: 1, width: 1398, height: 2034 },
    { screenId: 3, width: 2007, height: 2853 },
  ];

  beforeEach(async () => {
    spawnMock.mockReset();
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
    isFoldableSimulatorMock.mockReset().mockResolvedValue(true);
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("probes /api/display and keeps the panels, without reading which panel is live", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ foldable: true, panels: PANELS, hingeAngle: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const udid = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
    const device = iosDevice(udid);
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 61830);
    const instance = await factoryPromise;

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:61830/api/display");
    expect(instance.api.deviceId).toBe(udid);
    expect(instance.api.display).toEqual({ foldable: true, panels: PANELS, hingeAngle: null });
    // Which panel is live is every command's to resolve when it runs: the
    // probe is the one request the attach makes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("leaves a foldable single-panel when its server reports no panels (an older build)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = iosDevice("B6C52FD4-5408-402B-9369-EF7C66B98E6F");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 61831);
    const instance = await factoryPromise;

    expect(instance.api.display).toBeUndefined();
    await instance.dispose();
  });

  it("never probes a device whose profile is not foldable", async () => {
    isFoldableSimulatorMock.mockResolvedValue(false);
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = iosDevice("11111111-2222-3333-4444-555555555555");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 61832);
    const instance = await factoryPromise;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(instance.api.display).toBeUndefined();
    await instance.dispose();
  });
});

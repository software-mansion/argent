import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
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

vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => "/fake/bin/simulator-server",
  simulatorServerBinaryDir: () => "/fake/bin",
}));

// The factory now probes the runtime kind to reject tvOS sims. Mock it to the
// iOS path (false) so these spawn/stdio tests stay hermetic — no real `simctl`,
// which would otherwise hang the fake-timer test waiting on a child process.
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

// Device-set resolution reads the user's config + probes simctl — mock it to
// the default set (null) so spawns stay hermetic; the additional-set spawn
// test flips it per-case.
const deviceSetForUdidMock = vi.fn(async (_udid: string): Promise<string | null> => null);
vi.mock("../src/utils/ios-device-sets", () => ({
  deviceSetForUdid: (udid: string) => deviceSetForUdidMock(udid),
}));

// The MoQ transport an `ios-remote` device is driven over. Stubbed so the remote
// branch of the factory runs without a sim-remote orchestrator.
const sendControlMock = vi.fn(async (_payload: unknown) => {});
vi.mock("../src/utils/moq-client", () => ({
  openMoqClient: vi.fn(async () => ({
    sendControl: (payload: unknown) => sendControlMock(payload),
    close: vi.fn(async () => {}),
    events: new EventEmitter(),
  })),
}));

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; writable: boolean };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  // An EventEmitter, not a bare `{ write }`: a real `child.stdin` is a socket
  // that emits `error`, and the blueprint has to listen for it. `writable` is
  // part of that shape too — a real socket starts writable and turns false the
  // moment it is destroyed. Left off, the guard that reads it was unreachable
  // in every test here, so deleting that half kept the file green.
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), writable: true });
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
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
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

    instance.api.pressKey("Down", 0x29);
    instance.api.pressKey("Up", 0x29);

    expect(fakeProc.stdin.write).toHaveBeenNthCalledWith(1, "key Down 41\n");
    expect(fakeProc.stdin.write).toHaveBeenNthCalledWith(2, "key Up 41\n");
    // `pressKey` writes with no callback, so a write racing the child's death
    // emits EPIPE on the socket. With nothing listening, node's
    // `uncaughtException` handler crash-shuts down the whole tool-server —
    // which every agent session on the machine shares.
    expect(fakeProc.stdin.listenerCount("error")).toBe(1);
    expect(() => fakeProc.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });

  it.each([
    ["an EPIPE", (p: ReturnType<typeof makeFakeProc>) => p.stdin.emit("error", new Error("EPIPE"))],
    ["the pipe closing", (p: ReturnType<typeof makeFakeProc>) => p.stdin.emit("close")],
  ])("refuses every later pressKey after %s", async (_label, kill) => {
    // Swallowing the EPIPE is right — an unhandled one crash-shuts down the
    // whole tool-server, which every agent session on the machine shares. But
    // swallowing it must not swallow the FACT: `terminated` reaches the next
    // `resolveService`, not the call already holding this `api`, which is the
    // one about to report `cleared: true`. Measured on a booted simulator:
    // `kill -9` 50ms into a clear delivered 9 of 200 keys and the tool answered
    // `{ keys: 200, cleared: true }` with the field almost untouched.
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55558);
    const instance = await factoryPromise;

    instance.api.pressKey("Down", 0x29);
    expect(fakeProc.stdin.write).toHaveBeenCalledTimes(1);

    kill(fakeProc);

    let thrown: unknown;
    try {
      instance.api.pressKey("Up", 0x29);
    } catch (err) {
      thrown = err;
    }
    expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.SIMULATOR_SERVER_TERMINATED);
    // The pipe's own error rides along as the cause: the message says the helper
    // is gone, and the cause says how it went.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    // And nothing further was written: a burst that keeps going after the pipe
    // is gone is exactly what produced the silent success.
    expect(fakeProc.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("refuses a pressKey once the pipe is no longer writable", async () => {
    // The second half of the guard, and not redundant: `writable` turns false
    // the moment the stream is destroyed — a `dispose` on THIS side — where no
    // `error` and no `close` has been seen, so the recorded-EPIPE half has
    // seen nothing.
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55558);
    const instance = await factoryPromise;

    fakeProc.stdin.writable = false;
    expect(() => instance.api.pressKey("Down", 0x29)).toThrow(/no longer accepting key events/);
    expect(fakeProc.stdin.write).not.toHaveBeenCalled();
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

describe("simulatorServerBlueprint.factory — the remote MoQ key transport", () => {
  const REMOTE: DeviceInfo = {
    id: "AAAA1111-2222-3333-4444-555566667777",
    platform: "ios-remote",
    kind: "simulator",
  };

  async function remoteApi() {
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");
    const instance = await simulatorServerBlueprint.factory({} as never, REMOTE, {
      device: REMOTE,
    } as never);
    return instance.api;
  }

  it("never leaves a control-frame rejection unhandled", async () => {
    // `sendControl` used to be fired with a bare `void`, which attaches no
    // handler at all — and index.ts's `unhandledRejection` listener
    // `crashShutdown`s the WHOLE tool-server, one process shared by every agent
    // session on the machine. A clear burst issues 400 of these calls.
    sendControlMock.mockRejectedValue(new Error("MoQ control broadcast closed"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const api = await remoteApi();
      api.pressKey("Down", 42);
      // Two macrotask turns: enough for a rejection with no handler to be
      // reported, and for the `.catch` to have run if there is one.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      sendControlMock.mockReset();
      sendControlMock.mockImplementation(async () => {});
    }
  });

  it("refuses the next key once the control channel has failed", async () => {
    // The remote analogue of the local branch's `pipeDead` guard. Without it the
    // burst wrote 400 frames into a dead channel and still answered
    // `{ keys: 200, cleared: true }` for a field nothing had touched.
    sendControlMock.mockRejectedValueOnce(new Error("MoQ control broadcast closed"));
    const api = await remoteApi();
    api.pressKey("Down", 42);
    await new Promise((r) => setTimeout(r, 0));
    expect(() => api.pressKey("Up", 42)).toThrowError(/no longer accepting key events/);
    try {
      api.pressKey("Up", 42);
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SIMULATOR_SERVER_TERMINATED);
    }
  });

  it("keeps pressing while the channel is healthy", async () => {
    sendControlMock.mockClear();
    const api = await remoteApi();
    expect(() => {
      api.pressKey("Down", 42);
      api.pressKey("Up", 42);
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(sendControlMock).toHaveBeenCalledTimes(2);
  });
});

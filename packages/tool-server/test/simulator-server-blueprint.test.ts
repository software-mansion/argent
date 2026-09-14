import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { FAILURE_CODES, FailureError, Registry, type DeviceInfo } from "@argent/registry";
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
  simulatorServerRunDir: () => "/fake/bin",
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

/**
 * Only `runAdb` is replaced — `importOriginal` keeps every other export of
 * adb.ts real, so the modules that import them (and the Android branch's
 * `ensureDep` pre-warm below) behave exactly as they do in production.
 */
const runAdbMock = vi.fn(async (_args: string[], _options?: { timeoutMs?: number }) => ({
  stdout: "",
  stderr: "",
}));
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    runAdb: (args: string[], options?: { timeoutMs?: number }) => runAdbMock(args, options),
  };
});

/**
 * `exitOnKill` mirrors what a real simulator-server does with SIGTERM: it
 * exits. Dispose waits for that exit (bounded) before reaping the device, so a
 * fake that never exits is the "wedged binary" case, not the default one.
 */
function makeFakeProc({ exitOnKill = true }: { exitOnKill?: boolean } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = { write: vi.fn() };
  proc.kill = vi.fn(() => {
    // Asynchronously: dispose attaches its listener after calling kill().
    if (exitOnKill) setImmediate(() => proc.emit("exit", 0, null));
    return true;
  });
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
    runAdbMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
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

describe("simulatorServerBlueprint — reaps the on-device screen-sharing agent", () => {
  // The agent survives the simulator-server process on a physical phone: the
  // host cannot rely on the (unpinned, possibly old) Rust binary to stop it,
  // and a SIGKILLed or Windows-terminated binary never gets the chance. These
  // tests pin the argv, because the wrong pattern would kill Android Studio's
  // device mirror, which runs the same class.
  const SERIAL = "HT82A0203045";
  const SOCKET = "screen-sharing-agent-46527";

  function physicalDevice(serial = SERIAL): DeviceInfo {
    return { id: serial, platform: "android", kind: "device" };
  }

  /**
   * `adb reverse --list` answers these in order; the last one repeats. An
   * `Error` entry makes that probe fail, which is a different thing from an
   * empty listing and the reaper must treat it as one.
   */
  function reverseListReturns(...outputs: (string | Error)[]) {
    let call = 0;
    runAdbMock.mockImplementation(async (args: string[]) => {
      if (args[args.length - 1] === "--list") {
        const answer = outputs[Math.min(call, outputs.length - 1)] ?? "";
        call += 1;
        if (answer instanceof Error) throw answer;
        return { stdout: answer, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
  }

  const listedSocket = (socket: string) =>
    `${SERIAL} localabstract:${socket} tcp:${socket.split("-").pop()}\n`;

  /** The argv of every `runAdb` call that was not a `reverse --list` probe. */
  const reapCalls = () =>
    runAdbMock.mock.calls
      .map(([args]) => args)
      .filter((args) => args[args.length - 1] !== "--list");

  beforeEach(async () => {
    spawnMock.mockReset();
    runAdbMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("kills only this session's agent and drops its reverse mapping on dispose", async () => {
    reverseListReturns("", listedSocket(SOCKET));
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = physicalDevice();
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55560);
    const instance = await factoryPromise;

    await instance.dispose();

    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
    expect(reapCalls()).toEqual([
      // Bracket-escaped, so the `sh -c` adbd runs for this command does not
      // match its own argv and kill itself before reaching the agent. Scoped by
      // --socket, so an Android Studio mirror on the same phone survives.
      ["-s", SERIAL, "shell", `pkill -f 'screensharing[.]Main.*--socket=${SOCKET}'`],
      ["-s", SERIAL, "reverse", "--remove", `localabstract:${SOCKET}`],
    ]);

    // Idempotent: `stop-simulator-server` and a `terminated` teardown can both
    // reach dispose for one session.
    await instance.dispose();
    expect(reapCalls()).toHaveLength(2);
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
  });

  it("reaps once when the process exits on its own, through a real Registry teardown", async () => {
    reverseListReturns("", listedSocket(SOCKET));
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const registry = new Registry();
    registry.registerBlueprint(simulatorServerBlueprint);
    const device = physicalDevice();
    const resolved = registry.resolveService(`SimulatorServer:${SERIAL}`, { device });
    signalReady(fakeProc, 55561);
    await resolved;

    // The real path an unplugged phone or a killed binary takes: `exit` →
    // `terminated` → Registry._teardown → dispose.
    fakeProc.emit("exit", 0, null);
    await vi.waitFor(() => expect(reapCalls()).toHaveLength(2));

    expect(reapCalls()[0]).toEqual([
      "-s",
      SERIAL,
      "shell",
      `pkill -f 'screensharing[.]Main.*--socket=${SOCKET}'`,
    ]);
    await registry.dispose();
    expect(reapCalls()).toHaveLength(2);
  });

  it("touches no adb for an emulator — nothing runs on the device to reap", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = androidDevice("emulator-5554");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55562);
    const instance = await factoryPromise;
    await instance.dispose();

    expect(runAdbMock).not.toHaveBeenCalled();
  });

  it("resolves dispose when adb reports nothing to reap, and when it times out", async () => {
    reverseListReturns("", listedSocket(SOCKET));
    const nothingMatched = new FailureError("adb exited 1", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_exit_code: 1,
    });
    const timedOut = new FailureError("adb timed out", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "timeout",
      failure_signal: "SIGKILL",
    });

    for (const failure of [nothingMatched, timedOut]) {
      spawnMock.mockReset();
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);
      const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

      const device = physicalDevice();
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
      signalReady(fakeProc, 55563);
      const instance = await factoryPromise;

      // Both reap calls fail — dispose must still resolve, or the registry's
      // sequential teardown would stall on a phone that is asleep or gone.
      runAdbMock.mockRejectedValue(failure);
      await expect(instance.dispose()).resolves.toBeUndefined();
      reverseListReturns("", listedSocket(SOCKET));
    }
  });

  it("reaps on the ready-timeout path, where no instance exists to dispose", async () => {
    reverseListReturns("", listedSocket(SOCKET));
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    vi.useFakeTimers();
    try {
      const device = physicalDevice();
      // Never signals ready: the factory rejects after READY_TIMEOUT_MS, having
      // possibly already started the agent on the phone.
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
      const rejection = expect(factoryPromise).rejects.toThrow(/Timed out waiting/);
      await vi.advanceTimersByTimeAsync(31_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(reapCalls()).toEqual([
      ["-s", SERIAL, "shell", `pkill -f 'screensharing[.]Main.*--socket=${SOCKET}'`],
      ["-s", SERIAL, "reverse", "--remove", `localabstract:${SOCKET}`],
    ]);
  });

  it("kills nothing when the reverse diff is empty or ambiguous", async () => {
    // Empty: an older binary that registers no reverse socket. Ambiguous: an
    // Android Studio mirror started in the same window. A broad `pkill -f
    // screensharing.Main` would take that mirror down, so the reaper skips.
    const preexisting = listedSocket("screen-sharing-agent-41111");
    for (const [before, after] of [
      ["", ""],
      [
        preexisting,
        preexisting + listedSocket(SOCKET) + listedSocket("screen-sharing-agent-42222"),
      ],
    ]) {
      spawnMock.mockReset();
      reverseListReturns(before!, after!);
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);
      const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

      const device = physicalDevice();
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
      signalReady(fakeProc, 55564);
      const instance = await factoryPromise;
      await expect(instance.dispose()).resolves.toBeUndefined();

      expect(reapCalls()).toEqual([]);
      runAdbMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    }
  });

  it("kills nothing when the BEFORE snapshot failed, however the AFTER one looks", async () => {
    // The dangerous shape: the baseline probe fails (phone asleep, adb server
    // restarting) and a foreign agent — an Android Studio mirror — is the only
    // thing listed afterwards. Read as an empty baseline, that mirror would
    // look like this session's agent and the reaper would kill the user's
    // window. A failed probe must disable the reap instead.
    const foreign = "screen-sharing-agent-41111";
    // Every `reverse --list` reports the foreign socket…
    reverseListReturns(listedSocket(foreign));
    // …except the BEFORE snapshot, which rejects the way an offline phone or a
    // restarting adb server makes it reject.
    runAdbMock.mockRejectedValueOnce(
      new FailureError("adb: error: device offline", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_exit_code: 1,
      })
    );
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = physicalDevice();
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55565);
    const instance = await factoryPromise;
    await expect(instance.dispose()).resolves.toBeUndefined();

    expect(reapCalls()).toEqual([]);
    // The AFTER listing is never even requested: with no baseline there is
    // nothing to diff it against. Only the one rejected probe ran.
    expect(runAdbMock).toHaveBeenCalledTimes(1);
    // Proof the trap was armed — that single listing, had anything consulted
    // it, offers exactly one socket to mistake for this session's.
    await expect(runAdbMock(["-s", SERIAL, "reverse", "--list"])).resolves.toMatchObject({
      stdout: expect.stringContaining(foreign),
    });
  });

  it("lets the binary exit first, so it reaps only what the binary left behind", async () => {
    // A simulator-server with the device-side teardown stops the agent itself
    // after SIGTERM. Reaping 100ms later would match the agent it is busy
    // killing and report "stopped a leftover" for a clean shutdown.
    reverseListReturns("", listedSocket(SOCKET));
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = physicalDevice();
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55567);
    const instance = await factoryPromise;

    let exited = false;
    fakeProc.on("exit", () => {
      exited = true;
    });
    let exitedBeforePkill: boolean | null = null;
    const listImpl = runAdbMock.getMockImplementation()!;
    runAdbMock.mockImplementation(async (args, options) => {
      if (args[2] === "shell") exitedBeforePkill = exited;
      return listImpl(args, options);
    });

    await instance.dispose();

    expect(exitedBeforePkill).toBe(true);
  });

  it("reaps anyway when the binary does not exit within the grace window", async () => {
    // The wedged binary: SIGTERM changed nothing, so nothing on the device was
    // cleaned up and the bounded wait is the only reason dispose returns.
    reverseListReturns("", listedSocket(SOCKET));
    const fakeProc = makeFakeProc({ exitOnKill: false });
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = physicalDevice();
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55568);
    const instance = await factoryPromise;

    vi.useFakeTimers();
    try {
      const disposed = instance.dispose();
      let settled = false;
      void disposed.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(reapCalls()).toEqual([]);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await disposed;
      expect(reapCalls()).toEqual([
        ["-s", SERIAL, "shell", `pkill -f 'screensharing[.]Main.*--socket=${SOCKET}'`],
        ["-s", SERIAL, "reverse", "--remove", `localabstract:${SOCKET}`],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs only when it actually stopped an agent, or could not tell", async () => {
    // The log carries one signal worth having: the simulator-server binary
    // failed to clean up after itself. "Nothing matched" is the healthy case
    // and must stay silent, or the line stops meaning anything.
    const nothingMatched = new FailureError("adb exited 1", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_exit_code: 1,
    });
    const timedOut = new FailureError("adb timed out", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_command",
      failure_area: "tool_server",
      error_kind: "timeout",
      failure_signal: "SIGKILL",
    });

    const cases: [string, Error | null, RegExp | null][] = [
      ["killed something (exit 0)", null, /stopped a leftover screen-sharing agent/],
      ["nothing to kill (exit 1)", nothingMatched, null],
      ["could not ask (timeout)", timedOut, /could not stop the screen-sharing agent/],
    ];

    for (const [, pkillFailure, expected] of cases) {
      spawnMock.mockReset();
      runAdbMock.mockReset();
      reverseListReturns("", listedSocket(SOCKET));
      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);
      const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

      const device = physicalDevice();
      const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
      signalReady(fakeProc, 55566);
      const instance = await factoryPromise;

      if (pkillFailure) {
        const listImpl = runAdbMock.getMockImplementation()!;
        runAdbMock.mockImplementation(async (args, options) => {
          if (args[2] === "shell") throw pkillFailure;
          return listImpl(args, options);
        });
      }

      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await instance.dispose();
        const lines = stderrSpy.mock.calls.map(([chunk]) => String(chunk));
        if (expected) {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(expected);
        } else {
          expect(lines).toEqual([]);
        }
      } finally {
        stderrSpy.mockRestore();
      }
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

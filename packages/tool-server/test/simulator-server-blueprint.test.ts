import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { DeviceInfo } from "@argent/registry";

// ─── Mocks ───────────────────────────────────────────────────────────
//
// We mock at the module-boundary layer so the real blueprint factory runs —
// this is a repro of the dispatch, stdio and AX-automation behaviour, not a
// shape check. If any of these are quietly regressed, hands-on Android
// sessions will start failing before this test does, so the assertions below
// are deliberately specific (argv, stdio, ensureAutomationEnabled call count).

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
  ensureAutomationEnabled: ensureAutomationEnabledMock,
}));

vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => "/fake/bin/simulator-server",
  simulatorServerBinaryDir: () => "/fake/bin",
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
 * Push an `api_ready` line into stdout so readline's line event fires and the
 * blueprint resolves. We push on nextTick so the blueprint has time to attach
 * its listener after calling `spawn`.
 */
function signalReady(proc: ReturnType<typeof makeFakeProc>, port: number) {
  setImmediate(() => {
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
  beforeEach(() => {
    spawnMock.mockReset();
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns the `ios` subcommand and warms the AX automation flag for an iOS device", async () => {
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

    expect(ensureAutomationEnabledMock).toHaveBeenCalledTimes(1);
    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(udid);

    expect(instance.api.apiUrl).toBe("http://127.0.0.1:55555");
    expect(typeof instance.api.pressKey).toBe("function");

    await instance.dispose();
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
  });

  it("spawns the `android` subcommand and skips the iOS AX automation flag for an Android device", async () => {
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

    // No xcrun AX flag on Android — it is iOS-only and would error out.
    expect(ensureAutomationEnabledMock).not.toHaveBeenCalled();
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
    expect(ensureAutomationEnabledMock).not.toHaveBeenCalled();
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
  });

  it("swallows an iOS AX-automation failure — the server must still start", async () => {
    // ensureAutomationEnabled is best-effort: if xcrun isn't on PATH, or the
    // simulator is pre-booted with the flag set already, we must continue.
    ensureAutomationEnabledMock.mockRejectedValueOnce(new Error("xcrun missing"));

    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);
    const { simulatorServerBlueprint } = await import("../src/blueprints/simulator-server");

    const device = iosDevice("22222222-3333-4444-5555-666666666666");
    const factoryPromise = simulatorServerBlueprint.factory({}, device, { device });
    signalReady(fakeProc, 55559);
    const instance = await factoryPromise;

    expect(instance.api.apiUrl).toBe("http://127.0.0.1:55559");
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
});

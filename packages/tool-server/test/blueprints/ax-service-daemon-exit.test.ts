import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as net from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  ServiceInitializationError,
  type DeviceInfo,
} from "@argent/registry";
import type { IosEndpoint } from "../../src/utils/ios-host";

/**
 * Issue #800: on Intel Macs the ax-service daemon dies of SIGSEGV on every
 * attach. Nothing downstream could tell that from an ordinary exit, so
 * `describe` reported it as a simulator "not booted through argent" and
 * prescribed a reboot, without end.
 *
 * The daemon runs under `xcrun simctl spawn`, which outlives a child that a
 * signal killed: it prints "Child process terminated with signal 11:
 * Segmentation fault" and exits 139. So Node sees an exit code and no signal,
 * and these stand-ins end the same way.
 */
type Behavior = "idle" | "connect" | "crash-before-connect" | "crash-on-first-command";

interface FakeProc extends EventEmitter {
  stderr: PassThrough;
  killed: boolean;
  signals: string[];
  kill(signal?: string): boolean;
}

let behavior: Behavior = "connect";
let hostKind: "local" | "remote" = "local";
// What the factory measures before it starts the daemon: whether the sim was
// booted with argent's pre-boot accessibility settings.
let bootedThroughArgent = true;
const procs: FakeProc[] = [];
const daemonSockets: net.Socket[] = [];

/** What `simctl spawn` does when signal `number` kills its child. */
function simctlReportsSignal(
  proc: FakeProc,
  number: number,
  text: string,
  order: "stderr-first" | "exit-first" = "stderr-first"
): void {
  const line = `Child process terminated with signal ${number}: ${text}\n`;
  if (order === "exit-first") proc.emit("exit", 128 + number, null);
  proc.stderr.write(line);
  proc.stderr.end();
  if (order === "stderr-first") proc.emit("exit", 128 + number, null);
}

function fakeDaemon(endpoint: IosEndpoint): ChildProcess {
  if (endpoint.transport !== "unix") throw new Error("unix only here");
  const proc = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    killed: false,
    signals: [] as string[],
    kill(signal = "SIGTERM") {
      proc.killed = true;
      proc.signals.push(signal);
      return true;
    },
  }) as FakeProc;
  procs.push(proc);
  if (behavior === "crash-before-connect") {
    setImmediate(() => simctlReportsSignal(proc, 11, "Segmentation fault"));
  } else if (behavior !== "idle") {
    const socket = net.connect(endpoint.socketPath);
    daemonSockets.push(socket);
    if (behavior === "crash-on-first-command") {
      // The order a real crash arrives in: the socket closes, then simctl
      // reports the signal and exits.
      socket.once("data", () => {
        socket.destroy();
        setTimeout(() => simctlReportsSignal(proc, 11, "Segmentation fault"), 5);
      });
    }
  }
  return proc as unknown as ChildProcess;
}

vi.mock("../../src/utils/ios-host", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-host")>(
    "../../src/utils/ios-host"
  );
  return {
    ...actual,
    pickIosHost: () => ({
      kind: hostKind,
      requiresTcp: false,
      bootstrapAx: async () => ({ entitlementBypassActive: bootedThroughArgent }),
      spawnAxDaemon: (_udid: string, endpoint: IosEndpoint) => fakeDaemon(endpoint),
      startProxy: async () => {},
      stopProxy: async () => {},
    }),
  };
});

import {
  axDaemonCrashSignal,
  axDaemonExitError,
  axServiceBlueprint,
  axServiceRef,
  axStartFailureDegraded,
  readAxDaemonExit,
  type AXServiceApi,
} from "../../src/blueprints/ax-service";
import { describeIos } from "../../src/tools/describe/platforms/ios";

// Its own udid prefix: the socket path is /tmp/ax-<first 8 chars>.sock, and
// other suites run beside this one.
const UDID = "C0FFEE00-0800-4000-8000-000000000800";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

const disposers: Array<() => Promise<void>> = [];

async function attach() {
  const instance = await axServiceBlueprint.factory({}, device, { device });
  disposers.push(instance.dispose);
  return instance;
}

/** The factory spawns after two awaits, so the process is not there on return. */
async function spawned(index = 0): Promise<FakeProc> {
  await vi.waitFor(() => expect(procs.length).toBeGreaterThan(index));
  return procs[index];
}

const SEGFAULT_STDERR = "Child process terminated with signal 11: Segmentation fault\n";
// What simctl prints for an error of its own, here a simulator that is shut down.
const NOT_BOOTED_STDERR =
  "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n" +
  "Process spawn via launchd failed because device is not booted.\n";

beforeEach(() => {
  behavior = "connect";
  hostKind = "local";
  bootedThroughArgent = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
  for (const socket of daemonSockets.splice(0)) socket.destroy();
  procs.length = 0;
});

describe("readAxDaemonExit", () => {
  it("takes the signal from the line simctl prints for a signalled child", () => {
    expect(readAxDaemonExit(139, null, SEGFAULT_STDERR)).toEqual({ code: 139, signal: "SIGSEGV" });
    expect(
      readAxDaemonExit(134, null, "Child process terminated with signal 6: Abort trap\n")
    ).toEqual({ code: 134, signal: "SIGABRT" });
    // Darwin numbers it 10; Linux, where this suite also runs, numbers it 7.
    expect(
      readAxDaemonExit(138, null, "Child process terminated with signal 10: Bus error\n")
    ).toEqual({ code: 138, signal: "SIGBUS" });
  });

  it("does not take an exit code for a signal without that line", () => {
    // simctl exits with its own error's code modulo 256: SimError 405 exits
    // 149, and an error numbered 395 would exit 139, the code of a segfault.
    expect(readAxDaemonExit(149, null, NOT_BOOTED_STDERR)).toEqual({ code: 149 });
    expect(readAxDaemonExit(139, null, "")).toEqual({ code: 139 });
  });

  it("reports the signal Node saw kill the simctl process itself", () => {
    expect(readAxDaemonExit(null, "SIGTERM", "")).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("still names a signal it has no name for", () => {
    expect(
      readAxDaemonExit(158, null, "Child process terminated with signal 30: User defined\n")
    ).toEqual({ code: 158, signal: "signal 30" });
  });
});

describe("axDaemonExitError", () => {
  it("calls a fault signal a crash, in both phases", () => {
    const before = axDaemonExitError({ code: 139, signal: "SIGSEGV" }, "connecting");
    expect(before.message).toBe("ax-service crashed with SIGSEGV before connecting");
    expect(getFailureSignal(before)).toMatchObject({
      error_code: FAILURE_CODES.AX_DAEMON_CRASHED,
      failure_stage: "ax_service_spawn_ready",
      failure_command: "ax_service",
      failure_exit_code: 139,
    });
    expect(axDaemonCrashSignal(before)).toBe("SIGSEGV");

    const after = axDaemonExitError({ code: 134, signal: "SIGABRT" }, "connected");
    expect(after.message).toBe("ax-service crashed with SIGABRT");
    expect(getFailureSignal(after)).toMatchObject({
      error_code: FAILURE_CODES.AX_DAEMON_CRASHED,
      failure_stage: "ax_service_process_exit",
      failure_signal: "SIGABRT",
    });
    expect(axDaemonCrashSignal(after)).toBe("SIGABRT");
  });

  it.each(["SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE", "SIGBUS", "SIGSEGV", "SIGSYS"])(
    "counts %s as a crash",
    (signal) => {
      expect(axDaemonCrashSignal(axDaemonExitError({ code: null, signal }, "connected"))).toBe(
        signal
      );
    }
  );

  it.each(["SIGKILL", "SIGTERM", "SIGHUP", "SIGINT"])(
    "does not call a daemon that %s ended a crash",
    (signal) => {
      // A simulator that shuts down kills the daemon, and so does dispose. A
      // reboot does bring the daemon back after those.
      const err = axDaemonExitError({ code: 137, signal }, "connected");
      expect(err.message).toBe(`ax-service was killed by ${signal}`);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_DAEMON_PROCESS_ERROR);
      expect(axDaemonCrashSignal(err)).toBeUndefined();
    }
  );

  it("keeps an exit code an exit code", () => {
    const err = axDaemonExitError({ code: 1 }, "connecting");
    expect(err.message).toBe("ax-service exited with code 1 before connecting");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.AX_DAEMON_EXITED_BEFORE_READY,
      failure_exit_code: 1,
    });
    expect(axDaemonCrashSignal(err)).toBeUndefined();
  });

  it("is still found under the error the registry wraps a factory rejection in", () => {
    const crash = axDaemonExitError({ code: 139, signal: "SIGSEGV" }, "connecting");
    const wrapped = new ServiceInitializationError(`AXService:${UDID}`, crash.message, {
      cause: crash,
    });
    expect(axDaemonCrashSignal(wrapped)).toBe("SIGSEGV");
    expect(getFailureSignal(wrapped)?.error_code).toBe(FAILURE_CODES.AX_DAEMON_CRASHED);
    expect(axDaemonCrashSignal(new Error("ax-service not available"))).toBeUndefined();
    expect(axDaemonCrashSignal("ax-service crashed with SIGSEGV")).toBeUndefined();
  });
});

describe("ax-service blueprint: a daemon that dies before it connects", () => {
  beforeEach(() => {
    behavior = "idle";
  });

  it("names the signal that killed it", async () => {
    const pending = axServiceBlueprint.factory({}, device, { device });
    const proc = await spawned();
    simctlReportsSignal(proc, 11, "Segmentation fault");

    const err = await pending.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("ax-service crashed with SIGSEGV before connecting");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.AX_DAEMON_CRASHED,
      failure_exit_code: 139,
    });
    expect(axDaemonCrashSignal(err)).toBe("SIGSEGV");
  });

  it("reads the signal from a stderr line that arrives after the exit", async () => {
    const pending = axServiceBlueprint.factory({}, device, { device });
    const proc = await spawned();
    simctlReportsSignal(proc, 6, "Abort trap", "exit-first");

    await expect(pending).rejects.toThrow("ax-service crashed with SIGABRT before connecting");
  });

  it("does not report simctl's own failure as a crash", async () => {
    const pending = axServiceBlueprint.factory({}, device, { device });
    const proc = await spawned();
    proc.stderr.write(NOT_BOOTED_STDERR);
    proc.stderr.end();
    proc.emit("exit", 149, null);

    const err = await pending.then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe("ax-service exited with code 149 before connecting");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_DAEMON_EXITED_BEFORE_READY);
    expect(axDaemonCrashSignal(err)).toBeUndefined();
  });

  it("does not call a daemon the simulator killed a crash", async () => {
    const pending = axServiceBlueprint.factory({}, device, { device });
    const proc = await spawned();
    simctlReportsSignal(proc, 9, "Killed");

    const err = await pending.then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe("ax-service was killed by SIGKILL before connecting");
    expect(axDaemonCrashSignal(err)).toBeUndefined();
  });

  it.each([true, false])(
    "says how the sim was booted when the start fails (through argent: %s)",
    async (throughArgent) => {
      bootedThroughArgent = throughArgent;
      const pending = axServiceBlueprint.factory({}, device, { device });
      const proc = await spawned();
      proc.stderr.end();
      proc.emit("exit", 1, null);

      const err = await pending.then(
        () => undefined,
        (e: unknown) => e
      );
      expect(axStartFailureDegraded(err)).toBe(!throughArgent);
      // Still there under the error the registry wraps it in.
      const wrapped = new ServiceInitializationError(`AXService:${UDID}`, "failed", {
        cause: err as Error,
      });
      expect(axStartFailureDegraded(wrapped)).toBe(!throughArgent);
    }
  );

  it("says nothing about the boot state for a start that failed before it was measured", async () => {
    const android: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    const err = await axServiceBlueprint.factory({}, android, { device: android }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(axStartFailureDegraded(err)).toBeUndefined();
    expect(axStartFailureDegraded(new Error("ax-service not available"))).toBeUndefined();
  });
});

describe("ax-service blueprint: a daemon that dies after it connected", () => {
  it.each(["socket-first", "exit-first"] as const)(
    "fails the read in flight with the crash, not the disconnect it arrives as (%s)",
    async (order) => {
      const instance = await attach();
      const terminated = new Promise<Error | undefined>((resolve) =>
        instance.events.on("terminated", resolve)
      );
      const read = instance.api.describe().then(
        () => undefined,
        (e: unknown) => e
      );
      const proc = await spawned();
      await vi.waitFor(() => expect(daemonSockets).toHaveLength(1));

      if (order === "socket-first") {
        daemonSockets[0].destroy();
        // Long enough for the blueprint to see the close, far inside its grace.
        await new Promise((resolve) => setTimeout(resolve, 30));
        simctlReportsSignal(proc, 11, "Segmentation fault");
      } else {
        simctlReportsSignal(proc, 11, "Segmentation fault", "exit-first");
        daemonSockets[0].destroy();
      }

      const err = await read;
      expect((err as Error).message).toBe("ax-service crashed with SIGSEGV");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.AX_DAEMON_CRASHED,
        failure_stage: "ax_service_process_exit",
      });
      expect(axDaemonCrashSignal(err)).toBe("SIGSEGV");
      expect(await terminated).toBe(err);
    }
  );

  it("fails a read that starts after the socket closed with the crash too", async () => {
    // The service is still running until the exit is read. A read that
    // arrives in that window used to be possible only as "not connected",
    // which describe reports as an ordinary read failure.
    const instance = await attach();
    const proc = await spawned();
    await vi.waitFor(() => expect(daemonSockets).toHaveLength(1));
    const first = instance.api.describe().then(
      () => undefined,
      (e: unknown) => e
    );
    daemonSockets[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const late = instance.api.describe().then(
      () => undefined,
      (e: unknown) => e
    );
    simctlReportsSignal(proc, 11, "Segmentation fault");

    expect(((await late) as Error).message).toBe("ax-service crashed with SIGSEGV");
    expect(await first).toBe(await late);
  });

  it("answers not connected once the service has been disposed", async () => {
    const instance = await attach();
    await vi.waitFor(() => expect(daemonSockets).toHaveLength(1));
    daemonSockets[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await instance.dispose();

    // No verdict is coming any more, so the read must not wait for one.
    await expect(instance.api.describe()).rejects.toThrow("ax-service not connected");
  });

  it("reports a daemon that only disconnected as a disconnect, once the exit has had its chance", async () => {
    const instance = await attach();
    const read = instance.api.describe().then(
      () => undefined,
      (e: unknown) => e
    );
    await vi.waitFor(() => expect(daemonSockets).toHaveLength(1));
    const closedAt = Date.now();
    daemonSockets[0].destroy();

    const err = await read;
    expect((err as Error).message).toBe("ax-service daemon disconnected");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_DAEMON_PROCESS_ERROR);
    expect(axDaemonCrashSignal(err)).toBeUndefined();
    // It waited for an exit that could have named a signal.
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
  });

  it("does not wait for an exit a remote daemon can never report", async () => {
    hostKind = "remote";
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const instance = await attach();
    const read = instance.api.describe().then(
      () => undefined,
      (e: unknown) => e
    );
    await vi.waitFor(() => expect(daemonSockets).toHaveLength(1));
    daemonSockets[0].destroy();

    expect(((await read) as Error).message).toBe("ax-service daemon disconnected");
    // The only timer of a second is the grace a local daemon gets.
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toEqual([]);
  });

  it("does not report its own SIGTERM on dispose as a death", async () => {
    const instance = await attach();
    const onTerminated = vi.fn();
    instance.events.on("terminated", onTerminated);
    const proc = await spawned();

    await instance.dispose();
    expect(proc.signals).toEqual(["SIGTERM"]);
    // What the SIGTERM does to the real process, and to its socket.
    proc.emit("exit", null, "SIGTERM");
    daemonSockets[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onTerminated).not.toHaveBeenCalled();
  });

  it("does not report a crash that lands after dispose", async () => {
    const instance = await attach();
    const onTerminated = vi.fn();
    instance.events.on("terminated", onTerminated);
    const proc = await spawned();

    await instance.dispose();
    simctlReportsSignal(proc, 11, "Segmentation fault");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onTerminated).not.toHaveBeenCalled();
  });
});

describe("describeIos over a daemon that crashes (issue #800)", () => {
  function registryWithAx(): Registry {
    const registry = new Registry();
    registry.registerBlueprint(axServiceBlueprint);
    disposers.push(() => registry.dispose());
    return registry;
  }

  it.each(["crash-before-connect", "crash-on-first-command"] as const)(
    "says the service crashed, and prescribes no reboot (%s)",
    async (how) => {
      behavior = how;
      const registry = registryWithAx();

      const result = await describeIos(registry, device, {}, { isTvOs: false });

      expect(result.tree.children).toHaveLength(0);
      expect(result.hint).toContain("The accessibility service (ax-service) crashed with SIGSEGV");
      expect(result.hint).toContain("will not fix it");
      expect(result.hint).not.toContain("not booted through argent");
      expect(result.hint).not.toMatch(/call boot-device/);
      expect(result.should_restart).toBeUndefined();
    }
  );

  it("starts the daemon once per read, and says so again on the next one", async () => {
    behavior = "crash-before-connect";
    const registry = registryWithAx();

    const first = await describeIos(registry, device, {}, { isTvOs: false });
    expect(procs).toHaveLength(1);
    const second = await describeIos(registry, device, {}, { isTvOs: false });
    expect(procs).toHaveLength(2);

    expect(second.hint).toEqual(first.hint);
    expect(second.hint).toContain("crashed with SIGSEGV");
  });

  it("reports a crash the same way on a sim that was not booted through argent", async () => {
    // Blind and degraded would otherwise be the boot caveat and its reboot.
    bootedThroughArgent = false;
    for (const how of ["crash-before-connect", "crash-on-first-command"] as const) {
      behavior = how;
      const result = await describeIos(registryWithAx(), device, {}, { isTvOs: false });
      expect(result.hint).toContain("crashed with SIGSEGV");
      expect(result.hint).not.toContain("not booted through argent");
      expect(result.hint).not.toMatch(/call boot-device/);
    }
  });

  describe("a daemon that fails to start without crashing", () => {
    // What the daemon's exit looks like when simctl cannot run it at all, the
    // failure #800 reports from before the segfault began.
    const SPAWN_FAILED_STDERR =
      "An error was encountered processing the command (domain=com.apple.CoreSimulator.LaunchdSimError, code=111):\n" +
      "Process spawn via launchd failed.\n";

    async function describeWithFailedStart(): Promise<Awaited<ReturnType<typeof describeIos>>> {
      behavior = "idle";
      const pending = describeIos(registryWithAx(), device, {}, { isTvOs: false });
      const proc = await spawned(procs.length);
      proc.stderr.write(SPAWN_FAILED_STDERR);
      proc.stderr.end();
      proc.emit("exit", 111, null);
      return pending;
    }

    it("is not taken for a sim to reboot when the sim was booted through argent", async () => {
      // Every failed start used to mean "not booted through argent", so the
      // reboot it prescribed came back after each reboot.
      bootedThroughArgent = true;

      const result = await describeWithFailedStart();

      expect(result.hint).toContain(
        "The accessibility service failed to start ([AXService:" +
          UDID +
          "] ax-service exited with code 111 before connecting)."
      );
      expect(result.hint).not.toContain("not booted through argent");
      expect(result.hint).not.toMatch(/boot-device/);
      expect(result.hint).not.toContain("crashed");
    });

    it("keeps the boot caveat on a sim measured as not booted through argent", async () => {
      bootedThroughArgent = false;

      const result = await describeWithFailedStart();

      expect(result.hint).toContain("not booted through argent");
      expect(result.hint).toMatch(/call boot-device with force=true/);
    });
  });

  it("leaves the service resolvable again after a crash during a read", async () => {
    behavior = "crash-on-first-command";
    const registry = registryWithAx();
    const ref = axServiceRef(device);

    await describeIos(registry, device, {}, { isTvOs: false });
    // The crash tore the service down, so the next resolve starts a new daemon
    // instead of handing back the dead one.
    behavior = "connect";
    const api = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
    expect(procs).toHaveLength(2);
    expect(api.degraded).toBe(false);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
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
// Ways for the start to fail after that measurement and before the daemon runs.
let hostRequiresTcp = false;
let spawnError: Error | undefined;
let startProxyError: Error | undefined;
const proxyCalls: string[] = [];
const procs: FakeProc[] = [];
const daemonSockets: net.Socket[] = [];
// One per daemon connection the blueprint accepted, in order: settled once the
// blueprint has handled the close of its end.
const serverCloses: Promise<void>[] = [];

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
    const socket =
      endpoint.transport === "unix"
        ? net.connect(endpoint.socketPath)
        : net.connect(endpoint.port!, "127.0.0.1");
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
      requiresTcp: hostRequiresTcp,
      bootstrapAx: async () => ({ accessibilityPrefsEnabled: bootedThroughArgent }),
      spawnAxDaemon: (_udid: string, endpoint: IosEndpoint) => {
        if (spawnError) throw spawnError;
        return fakeDaemon(endpoint);
      },
      startProxy: async (_udid: string, port: number) => {
        proxyCalls.push(`start:${port}`);
        if (startProxyError) throw startProxyError;
      },
      stopProxy: async (_udid: string, port: number) => {
        proxyCalls.push(`stop:${port}`);
      },
    }),
  };
});

// The blueprint hands each accepted connection to the reader, which is the one
// place a test can get hold of the blueprint's end of the socket.
vi.mock("../../src/utils/ndjson-socket", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ndjson-socket")>(
    "../../src/utils/ndjson-socket"
  );
  return {
    ...actual,
    attachNdjsonReader: (...args: Parameters<typeof actual.attachNdjsonReader>) => {
      // This listener is registered before the blueprint's own, so it runs
      // first; the microtask puts the resolution after every `close` listener.
      // `socket.closed` would not do: it is already true inside `destroy()`.
      serverCloses.push(
        new Promise((resolve) => args[0].once("close", () => queueMicrotask(resolve)))
      );
      return actual.attachNdjsonReader(...args);
    },
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
import {
  __resetBootCaveatStateForTests,
  describeIos,
  withBootCaveatOncePerDevice,
} from "../../src/tools/describe/platforms/ios";

// Its own udid prefix: the socket path is /tmp/ax-<first 8 chars>.sock, and
// other suites run beside this one.
const UDID = "C0FFEE00-0800-4000-8000-000000000800";
const SOCKET_PATH = "/tmp/ax-C0FFEE00.sock";
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

/** Resolves once the blueprint has handled the close of its end of the daemon connection. */
function serverSideClosed(index = 0): Promise<void> {
  return serverCloses[index];
}

/**
 * Fakes the timers the blueprint sets from here on (the stderr drain, the
 * disconnect grace, RPC timeouts), so a test moves through them itself. Socket
 * and stream events stay real.
 */
function fakeBlueprintTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** How a promise stands after the microtasks that are already due have run. */
async function settledNow(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    ),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (e: unknown) => e
  );

const SEGFAULT_STDERR = "Child process terminated with signal 11: Segmentation fault\n";
// What simctl prints for an error of its own, here a simulator that is shut down.
const NOT_BOOTED_STDERR =
  "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n" +
  "Process spawn via launchd failed because device is not booted.\n";

beforeEach(() => {
  behavior = "connect";
  hostKind = "local";
  bootedThroughArgent = true;
  hostRequiresTcp = false;
  spawnError = undefined;
  startProxyError = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
  for (const socket of daemonSockets.splice(0)) socket.destroy();
  procs.length = 0;
  serverCloses.length = 0;
  proxyCalls.length = 0;
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

  it("does not wait for a stderr that had already ended when the exit arrived", async () => {
    // `end` fires once. With the stream already at its end there is nothing
    // left to wait for, and waiting anyway would hold every verdict back for
    // the whole drain window. The stand-in above calls `end()` in the same
    // tick as the exit, when the stream has not ended yet; this one lets it.
    const pending = axServiceBlueprint.factory({}, device, { device });
    pending.catch(() => {});
    const proc = await spawned();
    proc.stderr.write(SEGFAULT_STDERR);
    proc.stderr.end();
    await new Promise((resolve) => proc.stderr.once("end", resolve));
    expect(proc.stderr.readableEnded).toBe(true);
    fakeBlueprintTimers();

    proc.emit("exit", 139, null);

    // No timer has been advanced.
    expect(await settledNow(pending)).toBe("ax-service crashed with SIGSEGV before connecting");
  });

  it("waits for a line that arrives well after the exit", async () => {
    // `exit` and the last stderr chunk are separate events, and nothing orders
    // them. The stand-in above ends stderr in the same tick as the exit; this
    // one lets time pass in between, which is what the wait is for.
    const pending = failure(axServiceBlueprint.factory({}, device, { device }));
    const proc = await spawned();
    fakeBlueprintTimers();

    proc.emit("exit", 139, null);
    await vi.advanceTimersByTimeAsync(200);
    expect(await settledNow(pending)).toBe("pending");
    proc.stderr.write(SEGFAULT_STDERR);
    proc.stderr.end();

    expect(((await pending) as Error).message).toBe(
      "ax-service crashed with SIGSEGV before connecting"
    );
  });

  it("stops waiting for stderr after the drain window and reports what it has", async () => {
    // A daemon that outlives simctl can hold the pipe open, so the wait is bounded.
    const pending = failure(axServiceBlueprint.factory({}, device, { device }));
    const proc = await spawned();
    fakeBlueprintTimers();

    proc.emit("exit", 139, null);
    await vi.advanceTimersByTimeAsync(200);
    expect(await settledNow(pending)).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);

    // No line, so no signal: the code alone is not evidence of one.
    expect(((await pending) as Error).message).toBe(
      "ax-service exited with code 139 before connecting"
    );
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

describe("ax-service blueprint: a start that fails before the daemon runs", () => {
  // The boot state is measured first, so each of these knows it. Without it
  // describe takes the failure for a sim not booted through argent and
  // prescribes the reboot again after every reboot.
  const MISSING_BINARY = "ax-service binary not found: /nowhere/bin/darwin/ax-service";

  it.each([true, false])(
    "says how the sim was booted when the binary is missing (through argent: %s)",
    async (throughArgent) => {
      bootedThroughArgent = throughArgent;
      spawnError = new Error(MISSING_BINARY);

      const err = await failure(axServiceBlueprint.factory({}, device, { device }));

      expect(err).toBe(spawnError);
      expect(axStartFailureDegraded(err)).toBe(!throughArgent);
      // The listener that was already up is released with it.
      expect(fs.existsSync(SOCKET_PATH)).toBe(false);
    }
  );

  it("says how the sim was booted when the listener cannot bind", async () => {
    // A directory in the socket's place survives the pre-bind unlink.
    fs.mkdirSync(SOCKET_PATH);
    try {
      const err = await failure(axServiceBlueprint.factory({}, device, { device }));

      expect(err).toBeInstanceOf(Error);
      expect(axStartFailureDegraded(err)).toBe(false);
      expect(procs).toHaveLength(0);
    } finally {
      fs.rmdirSync(SOCKET_PATH);
    }
  });

  it("says how the sim was booted when the tunnel fails to start", async () => {
    hostRequiresTcp = true;
    startProxyError = new Error("sim-remote proxy start failed");

    const err = await failure(axServiceBlueprint.factory({}, device, { device }));

    expect(err).toBe(startProxyError);
    expect(axStartFailureDegraded(err)).toBe(false);
    expect(procs).toHaveLength(0);
    // A tunnel that never started is not stopped.
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]).toMatch(/^start:\d+$/);
  });

  it("stops the tunnel it started when the binary is missing", async () => {
    hostRequiresTcp = true;
    spawnError = new Error(MISSING_BINARY);

    const err = await failure(axServiceBlueprint.factory({}, device, { device }));

    expect(axStartFailureDegraded(err)).toBe(false);
    const port = proxyCalls[0].slice("start:".length);
    expect(proxyCalls).toEqual([`start:${port}`, `stop:${port}`]);
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
        await serverSideClosed();
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
    await serverSideClosed();

    const late = instance.api.describe().then(
      () => undefined,
      (e: unknown) => e
    );
    simctlReportsSignal(proc, 11, "Segmentation fault");

    expect(((await late) as Error).message).toBe("ax-service crashed with SIGSEGV");
    expect(await first).toBe(await late);
  });

  it("fails a read that starts after the close with the crash when the exit came first", async () => {
    // The other order: the exit is seen, its stderr is still being read, and
    // then the socket closes. The service is as much on its way out, so a read
    // that starts now waits for the verdict too.
    const instance = await attach();
    const proc = await spawned();
    fakeBlueprintTimers();

    proc.emit("exit", 139, null);
    daemonSockets[0].destroy();
    await serverSideClosed();
    const late = failure(instance.api.describe());
    expect(await settledNow(late)).toBe("pending");
    proc.stderr.write(SEGFAULT_STDERR);
    proc.stderr.end();

    expect(((await late) as Error).message).toBe("ax-service crashed with SIGSEGV");
  });

  it("lets an exit late in the grace window name the crash, with its stderr still to come", async () => {
    // The exit lands 900 ms after the close and its line 200 ms after that, past
    // the second the disconnect waits. The exit has to call the disconnect off,
    // or the read fails as a bare disconnect with the verdict 50 ms away.
    const instance = await attach();
    const proc = await spawned();
    fakeBlueprintTimers();
    const read = failure(instance.api.describe());

    daemonSockets[0].destroy();
    await serverSideClosed();
    await vi.advanceTimersByTimeAsync(900);
    proc.emit("exit", 139, null);
    await vi.advanceTimersByTimeAsync(200);
    expect(await settledNow(read)).toBe("pending");
    proc.stderr.write(SEGFAULT_STDERR);
    proc.stderr.end();

    expect(((await read) as Error).message).toBe("ax-service crashed with SIGSEGV");
  });

  it("answers not connected once the service has been disposed", async () => {
    const instance = await attach();
    daemonSockets[0].destroy();
    await serverSideClosed();
    await instance.dispose();

    // No verdict is coming any more, so the read must not wait for one.
    expect(await settledNow(instance.api.describe())).toBe("ax-service not connected");
  });

  it("answers not connected at once after a dispose that closes the socket itself", async () => {
    // The order dispose produces on its own: disposed first, then the close of
    // the socket it destroyed. That close must not set a verdict to wait for:
    // none comes, and a read would sit out its whole timeout.
    const instance = await attach();
    const onTerminated = vi.fn();
    instance.events.on("terminated", onTerminated);
    fakeBlueprintTimers();

    await instance.dispose();
    await serverSideClosed();

    expect(await settledNow(instance.api.describe())).toBe("ax-service not connected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTerminated).not.toHaveBeenCalled();
  });

  it("reports a daemon that only disconnected as a disconnect, once the exit has had its chance", async () => {
    const instance = await attach();
    fakeBlueprintTimers();
    const read = failure(instance.api.describe());
    daemonSockets[0].destroy();
    await serverSideClosed();

    // It waits for an exit that could name a signal.
    await vi.advanceTimersByTimeAsync(900);
    expect(await settledNow(read)).toBe("pending");
    await vi.advanceTimersByTimeAsync(200);

    const err = await read;
    expect((err as Error).message).toBe("ax-service daemon disconnected");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_DAEMON_PROCESS_ERROR);
    expect(axDaemonCrashSignal(err)).toBeUndefined();
  });

  it("does not wait for an exit a remote daemon can never report", async () => {
    hostKind = "remote";
    const instance = await attach();
    fakeBlueprintTimers();
    const read = instance.api.describe();
    daemonSockets[0].destroy();
    await serverSideClosed();

    // No timer has been advanced: a local daemon would still be in its grace.
    expect(await settledNow(read)).toBe("ax-service daemon disconnected");
  });

  it("does not report its own SIGTERM on dispose as a death", async () => {
    const instance = await attach();
    const onTerminated = vi.fn();
    instance.events.on("terminated", onTerminated);
    const proc = await spawned();
    fakeBlueprintTimers();

    await instance.dispose();
    expect(proc.signals).toEqual(["SIGTERM"]);
    // What the SIGTERM does to the real process.
    proc.emit("exit", null, "SIGTERM");
    await serverSideClosed();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onTerminated).not.toHaveBeenCalled();
  });

  it("does not report a crash that lands after dispose", async () => {
    const instance = await attach();
    const onTerminated = vi.fn();
    instance.events.on("terminated", onTerminated);
    const proc = await spawned();
    fakeBlueprintTimers();

    await instance.dispose();
    simctlReportsSignal(proc, 11, "Segmentation fault");
    await serverSideClosed();
    await vi.advanceTimersByTimeAsync(2_000);

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
      expect(result.hint).not.toContain("pre-boot accessibility settings");
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
      expect(result.hint).not.toContain("pre-boot accessibility settings");
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
      expect(result.hint).not.toContain("pre-boot accessibility settings");
      expect(result.hint).not.toMatch(/boot-device/);
      expect(result.hint).not.toContain("crashed");
    });

    it("keeps the reboot on a sim measured as not booted through argent, and says why the start failed", async () => {
      // The blind caveat alone said "the accessibility read returned no
      // elements" and dropped the error. No read took place, and the error is
      // what tells an agent whether the reboot is worth it.
      bootedThroughArgent = false;

      const result = await describeWithFailedStart();

      expect(result.hint).toContain(`AXService:${UDID}`);
      expect(result.hint).toContain("code 111");
      expect(result.hint).toContain("boot-device with force=true");
      expect(result.hint).toMatch(/do not reboot again/i);
      expect(result.hint).toContain(`NativeDevtools:${UDID}`);
      expect(result.hint).not.toContain("read returned no elements");
    });

    it("says a missing binary is missing, and prescribes no reboot for it", async () => {
      // Thrown before any process exists. On a sim booted through argent this
      // used to be the boot caveat, the same after every reboot.
      spawnError = new Error("ax-service binary not found: /nowhere/bin/darwin/ax-service");

      const result = await describeIos(registryWithAx(), device, {}, { isTvOs: false });

      expect(result.hint).toContain(
        `The accessibility service failed to start ([AXService:${UDID}] ax-service binary not ` +
          "found: /nowhere/bin/darwin/ax-service)."
      );
      expect(result.hint).not.toContain("pre-boot accessibility settings");
      expect(result.hint).not.toMatch(/boot-device/);
    });

    it("adds the system-app dead end to a failed start on a sim booted through argent", async () => {
      // Nothing brings the read of this app back, so the failure alone leaves
      // the empty tree unexplained and the agent without the next step.
      behavior = "idle";
      const pending = describeIos(
        registryWithAx(),
        device,
        { bundleId: "com.apple.Preferences" },
        { isTvOs: false }
      );
      const proc = await spawned();
      proc.stderr.end();
      proc.emit("exit", 1, null);
      const result = await pending;

      expect(result.hint).toMatch(
        /^The accessibility service failed to start \(.*exited with code 1 before connecting\)\. This is an Apple system app/
      );
      expect(result.hint).toContain("Take a `screenshot` to see the screen");
      expect(result.should_restart).toBeUndefined();
    });

    it("keeps the reboot ahead of the system-app dead end on a sim not booted through argent", async () => {
      // A boot through argent may let the service read this app, so the
      // terminal hint must not replace the one thing left to try.
      bootedThroughArgent = false;
      behavior = "idle";
      const pending = describeIos(
        registryWithAx(),
        device,
        { bundleId: "com.apple.Preferences" },
        { isTvOs: false }
      );
      const proc = await spawned();
      proc.stderr.end();
      proc.emit("exit", 1, null);
      const result = await pending;

      expect(result.hint).toContain("Call boot-device with force=true");
      expect(result.hint).not.toContain("Apple system app");
    });

    it("tells a provider's device that the native fallback is not there either", async () => {
      // The factory refuses a provider's device this suite has not registered,
      // so the failure of a real start is handed to describe for one.
      behavior = "idle";
      const pending = failure(axServiceBlueprint.factory({}, device, { device }));
      const proc = await spawned();
      proc.stderr.end();
      proc.emit("exit", 1, null);
      const cause = (await pending) as Error;
      const registry = {
        resolveService: async () => {
          throw new ServiceInitializationError(`AXService:${UDID}`, cause.message, { cause });
        },
      } as unknown as Registry;
      const external: DeviceInfo = {
        id: `ext:provider:${UDID}`,
        platform: "ios",
        kind: "simulator",
      };

      const result = await describeIos(registry, external, {}, { isTvOs: false });

      expect(result.hint).toContain("code 1 before connecting");
      expect(result.hint).toMatch(/external provider/i);
      expect(result.hint).toMatch(/fallback.*unavailable/i);
      expect(result.hint).toContain("screenshot");
    });
  });

  describe("the standing boot caveat around a start that fails", () => {
    // A failed start has a hint that is neither caveat, like a crash. What
    // keeps it from clearing the once-per-device state is that the read is
    // recorded as one whose daemon was gone, with the boot state it measured.
    beforeEach(() => {
      __resetBootCaveatStateForTests();
    });

    // A sim not booted through argent whose read works: the standing caveat.
    const degradedAx = {
      degraded: true,
      describe: async () => ({
        alertVisible: false,
        screenFrame: { width: 440, height: 956 },
        elements: [
          { label: "General", frame: { x: 0.05, y: 0.3, width: 0.9, height: 0.05 }, traits: [] },
        ],
      }),
    } as unknown as AXServiceApi;

    /** One read as the `describe` tool makes it, over a service or its failure to start. */
    async function toolRead(ax: AXServiceApi | Error) {
      const registry = {
        resolveService: async (urn: string) => {
          if (!urn.startsWith("AXService:")) throw new Error("no native devtools here");
          if (ax instanceof Error) throw ax;
          return ax;
        },
      } as unknown as Registry;
      return withBootCaveatOncePerDevice(
        device.id,
        await describeIos(registry, device, {}, { isTvOs: false })
      );
    }

    /** What the registry rejects with when a real start exits 1 before connecting. */
    async function failedStart(throughArgent: boolean): Promise<Error> {
      bootedThroughArgent = throughArgent;
      behavior = "idle";
      const pending = failure(axServiceBlueprint.factory({}, device, { device }));
      const proc = await spawned(procs.length);
      proc.stderr.end();
      proc.emit("exit", 1, null);
      const cause = (await pending) as Error;
      return new ServiceInitializationError(`AXService:${UDID}`, cause.message, { cause });
    }

    it("is not re-armed by a failed start on a sim measured as not booted through argent", async () => {
      expect((await toolRead(degradedAx)).hint).toContain("pre-boot accessibility settings");

      const failed = await toolRead(await failedStart(false));
      expect(failed.hint).toContain("ax-service exited with code 1 before connecting");
      expect(failed.hint).toContain("Call boot-device with force=true");

      // Same sim, same state: the caveat already told stays told.
      expect((await toolRead(degradedAx)).hint).toBeUndefined();
    });

    it("is re-armed by a failed start on a sim measured as booted through argent", async () => {
      // That read found the sim off the state the caveat describes, so a later
      // external boot of the same udid has not been told.
      expect((await toolRead(degradedAx)).hint).toContain("pre-boot accessibility settings");

      const failed = await toolRead(await failedStart(true));
      expect(failed.hint).toContain("ax-service exited with code 1 before connecting).");
      expect(failed.hint).not.toMatch(/boot-device/);

      expect((await toolRead(degradedAx)).hint).toContain("pre-boot accessibility settings");
    });

    it.each([true, false])(
      "is not consumed by a failed start that comes first (through argent: %s)",
      async (throughArgent) => {
        expect((await toolRead(await failedStart(throughArgent))).hint).toContain(
          "The accessibility service failed to start"
        );
        expect((await toolRead(degradedAx)).hint).toContain("pre-boot accessibility settings");
        expect((await toolRead(degradedAx)).hint).toBeUndefined();
      }
    );
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

// The helper drops a connection after 60 s without a request but keeps
// listening, and `am instrument` stays alive. The blueprint reconnects to the
// same forward instead of tearing the helper down, and on dispose lets `am`
// exit on its own after `shutdown`: killing adb first orphans or crashes the
// helper on the device.
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });
}

let proc: FakeProc;
const log: string[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: () => {
      proc = new FakeProc();
      setImmediate(() => proc.stdout.write("INSTRUMENTATION_STATUS: port=41000\n"));
      return proc;
    },
  };
});

vi.mock("../../src/utils/adb", () => {
  const runAdb = vi.fn(async (args: string[]) => {
    if (args.includes("--remove")) log.push("forward-remove");
    if (args.includes("force-stop")) {
      log.push("force-stop");
      await forceStopGate;
      log.push("force-stopped");
    }
    return args.includes("forward")
      ? { stdout: `${helperPort}\n`, stderr: "" }
      : { stdout: "", stderr: "" };
  });
  return {
    runAdb,
    // Goes through runAdb above, as the real one does.
    adbForward: vi.fn(async (serial: string, hostPort: number, devicePort: number) => {
      const { stdout } = await runAdb([
        "-s",
        serial,
        "forward",
        `tcp:${hostPort}`,
        `tcp:${devicePort}`,
      ]);
      return stdout.trim();
    }),
    adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:3\n"),
  };
});

vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/usr/bin/adb"),
}));

vi.mock("@argent/native-devtools-android", () => ({
  helperManifest: () => ({
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.3.0",
    versionCode: 3,
    installFlags: ["-r", "-t"],
  }),
  bundledHelperApkPath: () => "/tmp/argent-android-devtools.apk",
}));

import { androidDevtoolsBlueprint } from "../../src/blueprints/android-devtools";

const DEVICE: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

// A helper behind the forward: one connection per accept, NDJSON both ways.
let helperPort = 0;
let server: net.Server;
let connections: net.Socket[] = [];
/** `undefined` leaves the request unanswered. */
let answer: (method: string) => { result?: unknown; error?: unknown } | undefined;
/** How long `am instrument` takes to exit after `shutdown`; `null` never. */
let exitAfterShutdownMs: number | null;
/** `am force-stop` returns once this settles; unset, at once. */
let forceStopGate: Promise<void> | undefined;

/** Hold `am force-stop` open until the returned function is called. */
function holdForceStop(): () => void {
  let release!: () => void;
  forceStopGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

/** Let pending I/O and promise callbacks run; timers are not advanced. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether `promise` has settled, without waiting for it. */
function watch(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  );
  return state;
}

beforeEach(async () => {
  log.length = 0;
  connections = [];
  exitAfterShutdownMs = 50;
  forceStopGate = undefined;
  answer = () => ({ result: { ok: true } });
  server = net.createServer((socket) => {
    connections.push(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const { id, method } = JSON.parse(buf.slice(0, nl)) as { id: number; method: string };
        buf = buf.slice(nl + 1);
        log.push(method);
        const reply = answer(method);
        if (reply) socket.write(JSON.stringify({ id, ...reply }) + "\n");
        if (method === "shutdown" && exitAfterShutdownMs !== null) {
          setTimeout(() => {
            log.push("exit");
            proc.emit("exit", 0, null);
          }, exitAfterShutdownMs);
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  helperPort = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  for (const socket of connections) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

async function start() {
  const instance = await androidDevtoolsBlueprint.factory({}, DEVICE, { device: DEVICE });
  const terminated: Array<Error | undefined> = [];
  instance.events.on("terminated", (err) => terminated.push(err));
  return { instance, terminated };
}

/** Close the connection from the helper's side, as its read timeout does. */
async function helperClosesConnection(index = connections.length - 1) {
  connections[index]!.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("android-devtools connection lifecycle", () => {
  it("reconnects to the same forward after the helper closes an idle connection", async () => {
    const { instance, terminated } = await start();

    await helperClosesConnection();

    await expect(instance.api.ping()).resolves.toEqual({ ok: true });
    expect(terminated).toEqual([]);
    expect(connections).toHaveLength(2);
    expect(instance.api.isReady()).toBe(true);

    await instance.dispose();
  });

  it("rejects the request in flight at the close, and serves the next one", async () => {
    const { instance, terminated } = await start();
    answer = (method) => (method === "getHierarchy" ? undefined : { result: { ok: true } });

    const inFlight = instance.api.getHierarchy().catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await helperClosesConnection();

    expect(getFailureSignal(await inFlight)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_SOCKET_CLOSED
    );
    await expect(instance.api.getScreenSize()).resolves.toEqual({ ok: true });
    expect(terminated).toEqual([]);

    await instance.dispose();
  });

  it("terminates when the socket closes after `am instrument` exited", async () => {
    const { instance, terminated } = await start();

    proc.emit("exit", 0, null);
    await helperClosesConnection();

    expect(terminated.length).toBeGreaterThan(0);
    expect(getFailureSignal(terminated[0])?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_TERMINATED
    );
    await expect(instance.api.ping()).rejects.toThrow();
    expect(connections).toHaveLength(1);

    await instance.dispose();
  });

  it("terminates once, without retrying, when the reconnect is refused", async () => {
    const { instance, terminated } = await start();
    await helperClosesConnection();
    await new Promise((resolve) => server.close(resolve));
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const err = await instance.api.ping().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(terminated).toHaveLength(1);
    expect(connections).toHaveLength(1);

    await instance.dispose();
  });

  // #1442: a helper whose UiAutomation never registered still answers ping.
  // The idle close used to be what replaced it.
  it("terminates when the helper reports UiAutomation not connected", async () => {
    const { instance, terminated } = await start();
    answer = (method) =>
      method === "getHierarchy"
        ? {
            error: {
              type: "java.lang.IllegalStateException",
              message: "UiAutomation not connected, UiAutomation@5d1c2b[id=-1, flags=0]",
            },
          }
        : { result: { ok: true } };

    await expect(instance.api.getHierarchy()).rejects.toThrow("UiAutomation not connected");
    expect(terminated).toHaveLength(1);

    await instance.dispose();
  });

  // #1880: a helper that stops answering keeps its UiAutomation registration,
  // so the describe fallback's `uiautomator dump` dies until it is stopped.
  it("force-stops and terminates a helper whose getHierarchy times out", async () => {
    const { instance, terminated } = await start();
    answer = (method) => (method === "getHierarchy" ? undefined : { result: { ok: true } });
    const { runAdb } = await import("../../src/utils/adb");
    const forceStop = [
      "-s",
      "emulator-5554",
      "shell",
      "am",
      "force-stop",
      "com.argent.androiddevtools",
    ];

    const release = holdForceStop();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const read = instance.api.getHierarchy().catch((err: unknown) => err);
      const state = watch(read);
      await vi.advanceTimersByTimeAsync(15_000);
      await flush();

      // Awaited before the error reaches the caller, so its fallback dump can register.
      expect(vi.mocked(runAdb)).toHaveBeenCalledWith(forceStop, { timeoutMs: 5_000 });
      expect(state.settled).toBe(false);
      release();
      const err = await read;

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT);
      expect(terminated).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    await instance.dispose();
  });

  it("keeps the helper when setText times out, since the text may have landed", async () => {
    const { instance, terminated } = await start();
    answer = (method) => (method === "setText" ? undefined : { result: { ok: true } });
    const { runAdb } = await import("../../src/utils/adb");
    vi.mocked(runAdb).mockClear();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const typed = instance.api.setText("x");
      await vi.advanceTimersByTimeAsync(14_000);
      await expect(typed).resolves.toMatchObject({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }

    expect(terminated).toHaveLength(0);
    expect(
      vi.mocked(runAdb).mock.calls.some(([args]) => (args as string[]).includes("force-stop"))
    ).toBe(false);
    await instance.dispose();
  });

  // After 60 s idle the first request is the reconnect's ping, not the caller's RPC.
  it("force-stops a helper whose reconnect ping times out, before rejecting", async () => {
    const { instance, terminated } = await start();
    await helperClosesConnection();
    answer = (method) => (method === "ping" ? undefined : { result: { ok: true } });
    const pings = () => log.filter((method) => method === "ping").length;
    const pingsBefore = pings();
    const release = holdForceStop();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const read = instance.api.getHierarchy().catch((err: unknown) => err);
      const state = watch(read);
      // The ping's timer starts once the new socket has connected.
      while (pings() === pingsBefore) await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();

      expect(log).toContain("force-stop");
      expect(state.settled).toBe(false);
      release();

      expect(getFailureSignal(await read)?.error_code).toBe(
        FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT
      );
      expect(terminated).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    await instance.dispose();
  });

  // The ping timed out, so `setText` was never sent: nothing "may have landed".
  it("rejects setText when the reconnect ping times out, instead of reporting a fill", async () => {
    const { instance } = await start();
    await helperClosesConnection();
    answer = (method) => (method === "ping" ? undefined : { result: { ok: true } });
    const pings = () => log.filter((method) => method === "ping").length;
    const pingsBefore = pings();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const typed = instance.api.setText("hello").catch((err: unknown) => err);
      while (pings() === pingsBefore) await flush();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(getFailureSignal(await typed)?.error_code).toBe(
        FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT
      );
      expect(log).not.toContain("setText");
    } finally {
      vi.useRealTimers();
    }

    await instance.dispose();
  });

  it("force-stops a helper that does not answer shutdown, instead of orphaning it", async () => {
    const { instance } = await start();
    answer = (method) => (method === "shutdown" ? undefined : { result: { ok: true } });
    exitAfterShutdownMs = null;
    const release = holdForceStop();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const disposing = instance.dispose();
      const state = watch(disposing);
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();

      expect(log.slice(-2)).toEqual(["shutdown", "force-stop"]);
      expect(state.settled).toBe(false);
      release();
      await disposing;
    } finally {
      vi.useRealTimers();
    }

    expect(log.slice(-4)).toEqual(["shutdown", "force-stop", "force-stopped", "forward-remove"]);
  });

  // A hung adb transport: the launcher's SIGKILL follows 6 s after a stop.
  it("stops waiting for the force-stop after 2 s on dispose", async () => {
    const { instance } = await start();
    answer = (method) => (method === "shutdown" ? undefined : { result: { ok: true } });
    exitAfterShutdownMs = null;
    const release = holdForceStop();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const disposing = instance.dispose();
      const state = watch(disposing);
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      await vi.advanceTimersByTimeAsync(1_900);
      await flush();
      expect(state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      await disposing;
    } finally {
      vi.useRealTimers();
    }

    expect(log.slice(-3)).toEqual(["shutdown", "force-stop", "forward-remove"]);
    release();
  });

  it("lets `am instrument` exit after shutdown before removing the forward, without a kill", async () => {
    const { instance } = await start();
    exitAfterShutdownMs = 150;

    await instance.dispose();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(log.slice(-3)).toEqual(["shutdown", "exit", "forward-remove"]);
  });

  it("kills `am instrument` when it has not exited 3 s after shutdown", async () => {
    const { instance } = await start();
    exitAfterShutdownMs = null;
    const started = Date.now();

    await instance.dispose();

    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(log.at(-1)).toBe("forward-remove");
  });

  it("opens a fresh connection to send shutdown when the helper closed the last one", async () => {
    const { instance } = await start();
    await helperClosesConnection();

    await instance.dispose();

    expect(connections).toHaveLength(2);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(log.slice(-3)).toEqual(["shutdown", "exit", "forward-remove"]);
  });
});

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

vi.mock("../../src/utils/adb", () => ({
  runAdb: vi.fn(async (args: string[]) => {
    if (args.includes("--remove")) log.push("forward-remove");
    return args.includes("forward")
      ? { stdout: `${helperPort}\n`, stderr: "" }
      : { stdout: "", stderr: "" };
  }),
  adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:3\n"),
}));

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

beforeEach(async () => {
  log.length = 0;
  connections = [];
  exitAfterShutdownMs = 50;
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

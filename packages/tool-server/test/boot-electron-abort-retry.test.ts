import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { pickFreePort } from "../src/utils/free-port";

const spawnMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});
const trackMock = vi.fn();
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: (port: number) => trackMock(port),
  untrackChromiumPort: vi.fn(),
}));
const readyMock = vi.fn();
vi.mock("../src/blueprints/chromium-cdp", () => ({
  ensureCdpReachable: (port: number) => readyMock(port),
}));

import { bootElectronApp, chromiumSwitchNames } from "../src/tools/devices/boot-electron";

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  unref: () => void;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 12345;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = vi.fn(() => true);
  ee.exitCode = null;
  ee.signalCode = null;
  return ee;
}

const appBinary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "argent-abort-retry-")), "app");
fs.writeFileSync(appBinary, "");
afterAll(() => fs.rmSync(path.dirname(appBinary), { recursive: true, force: true }));

// Failure paths run killChildEscalating's group sweep on a stand-in pid.
vi.spyOn(process, "kill").mockImplementation(() => true);

async function listen(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

beforeEach(() => {
  spawnMock.mockReset();
  trackMock.mockReset();
  readyMock.mockReset();
  readyMock.mockRejectedValue(new Error("ECONNREFUSED"));
});

describe("chromiumSwitchNames", () => {
  it.each([
    ["--user-data-dir=/p", "linux", "user-data-dir"],
    ["--user-data-dir", "darwin", "user-data-dir"],
    ["-user-data-dir=/p", "linux", "user-data-dir"],
    [" \t--user-data-dir=/p\n", "linux", "user-data-dir"],
    ["---user-data-dir=/p", "linux", "-user-data-dir"],
    ["/user-data-dir=/p", "linux", undefined],
    ["--User-Data-Dir=/p", "linux", "User-Data-Dir"],
    ["/user-data-dir=C:\\p", "win32", "user-data-dir"],
    ["--User-Data-Dir=C:\\p", "win32", "user-data-dir"],
    ["http://localhost/--user-data-dir", "linux", undefined],
    ["-user-data-dir=C:\\p", "win32", "user-data-dir"],
    ["about:blank", "win32", undefined],
    ["C:\\page.html", "win32", undefined],
    ["-", "linux", undefined],
    [" - ", "darwin", undefined],
    ["/", "win32", undefined],
    ["--", "linux", ""],
  ] as const)("%j on %s -> %s", (arg, platform, expected) => {
    expect(chromiumSwitchNames([arg], platform)).toEqual([expected]);
  });

  it("reads everything after a bare -- as an argument", () => {
    expect(
      chromiumSwitchNames(["--headless=new", " -- ", "--user-data-dir=/p", "-", "--"], "linux")
    ).toEqual(["headless", "", undefined, undefined, undefined]);
  });
});

describe("bootElectronApp", () => {
  it("drops a single-dash --remote-debugging-port too", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await bootElectronApp({
      appPath: appBinary,
      readyTimeoutMs: 50,
      extraArgs: ["-remote-debugging-port=9", "--headless=new"],
    }).catch(() => {});
    const args: string[] = spawnMock.mock.calls[0]![1];
    expect(args).not.toContain("-remote-debugging-port=9");
    expect(args).toContain("--headless=new");
  });

  it("keeps a --remote-debugging-port that follows a bare --, where Chromium reads a URL", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    await bootElectronApp({
      appPath: appBinary,
      readyTimeoutMs: 50,
      extraArgs: ["--", "--remote-debugging-port=9"],
    }).catch(() => {});
    expect(spawnMock.mock.calls[0]![1].slice(-2)).toEqual(["--", "--remote-debugging-port=9"]);
  });

  it("stops probing the port once the boot has failed", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const boot = bootElectronApp({ appPath: appBinary }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(readyMock).toHaveBeenCalled());
    child.emit("exit", 1, null);
    child.stderr.emit("end");
    await boot;
    const probes = readyMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(readyMock.mock.calls.length).toBe(probes);
  });

  it("leaves no listener on the call's signal, whether the boot succeeds or fails", async () => {
    const controller = new AbortController();
    spawnMock.mockReturnValue(makeFakeChild());
    readyMock.mockResolvedValue(undefined);
    await bootElectronApp({ appPath: appBinary, signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);

    spawnMock.mockReturnValue(makeFakeChild());
    readyMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await bootElectronApp({
      appPath: appBinary,
      readyTimeoutMs: 50,
      signal: controller.signal,
    }).catch(() => {});
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("runs onProcessGone when a child that booted exits later", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    readyMock.mockResolvedValue(undefined);
    const gone = vi.fn();
    await bootElectronApp({ appPath: appBinary, kind: "browser", onProcessGone: gone });
    expect(gone).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("kills the child and fails when the call is aborted inside the confirm window", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    readyMock.mockImplementation(async () => {
      setTimeout(() => controller.abort(), 20);
    });
    const err = await bootElectronApp({
      appPath: appBinary,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).message).toBe("Electron boot was cancelled.");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("waits for a failed boot's dying child to free its fixed port before probing it again", async () => {
    const port = await pickFreePort();
    const first = makeFakeChild();
    spawnMock.mockReturnValueOnce(first);
    const failed = await bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(failed)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_CDP_TIMEOUT);

    // The killed child still holds the port.
    const holder = await listen(port);
    spawnMock.mockReturnValueOnce(makeFakeChild());
    const retry = bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(
      (e: unknown) => e
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    first.signalCode = "SIGTERM";

    expect(getFailureSignal(await retry)?.error_code).toBe(
      FAILURE_CODES.CHROMIUM_ELECTRON_CDP_TIMEOUT
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("waits for a dying child that has not bound its fixed port yet", async () => {
    const port = await pickFreePort();
    const first = makeFakeChild();
    spawnMock.mockReturnValueOnce(first);
    await bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(() => {});

    spawnMock.mockReturnValueOnce(makeFakeChild());
    const retry = bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(
      (e: unknown) => e
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    first.signalCode = "SIGTERM";

    expect(getFailureSignal(await retry)?.error_code).toBe(
      FAILURE_CODES.CHROMIUM_ELECTRON_CDP_TIMEOUT
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("spawns nothing when the call is aborted while it waits for a dying child", async () => {
    const port = await pickFreePort();
    const first = makeFakeChild();
    spawnMock.mockReturnValueOnce(first);
    await bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(() => {});

    const controller = new AbortController();
    const retry = bootElectronApp({ appPath: appBinary, port, signal: controller.signal }).catch(
      (e: unknown) => e
    );
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    first.signalCode = "SIGTERM";

    expect(((await retry) as Error).name).toBe("AbortError");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a dying child that has not exited after 5 s", async () => {
    const port = await pickFreePort();
    spawnMock.mockReturnValueOnce(makeFakeChild());
    await bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(() => {});

    spawnMock.mockReturnValueOnce(makeFakeChild());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const retry = bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(
        () => {}
      );
      vi.setSystemTime(Date.now() + 4800);
      await new Promise((r) => setTimeout(r, 150));
      expect(spawnMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 200);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      vi.setSystemTime(Date.now() + 1000);
      await retry;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses the fixed port when it is still held once the dying child has exited", async () => {
    const port = await pickFreePort();
    const first = makeFakeChild();
    spawnMock.mockReturnValueOnce(first);
    await bootElectronApp({ appPath: appBinary, port, readyTimeoutMs: 50 }).catch(() => {});
    first.signalCode = "SIGTERM";
    const holder = await listen(port);
    try {
      const err = await bootElectronApp({ appPath: appBinary, port }).catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      holder.close();
    }
  });
});

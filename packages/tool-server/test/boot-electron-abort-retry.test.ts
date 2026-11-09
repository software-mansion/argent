import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
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

import { bootElectronApp, isChromiumSwitch } from "../src/tools/devices/boot-electron";

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

describe("isChromiumSwitch", () => {
  it.each([
    ["--user-data-dir=/p", "linux", true],
    ["--user-data-dir", "darwin", true],
    ["-user-data-dir=/p", "linux", true],
    ["---user-data-dir=/p", "linux", false],
    ["--user-data-dir-x=/p", "linux", false],
    ["/user-data-dir=/p", "linux", false],
    ["--User-Data-Dir=/p", "linux", false],
    ["/user-data-dir=C:\\p", "win32", true],
    ["--User-Data-Dir=C:\\p", "win32", true],
    ["http://localhost/--user-data-dir", "linux", false],
  ] as const)("%s on %s -> %s", (arg, platform, expected) => {
    expect(isChromiumSwitch(arg, "user-data-dir", platform)).toBe(expected);
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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { scopeTempHome } from "./helpers/temp-home";

// Node's fetch refuses port 1 before dialing, so readiness never succeeds.
const UNREACHABLE_CDP_PORT = 1;

const spawnMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp } from "../src/tools/devices/boot-electron";

scopeTempHome("argent-boot-electron-gone-home-");

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stderr: EventEmitter;
  unref: () => void;
  kill: () => boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(pid?: number): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = () => true;
  ee.exitCode = null;
  ee.signalCode = null;
  return ee;
}

let appBinary: string;
beforeAll(() => {
  appBinary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "argent-gone-test-")), "app");
  fs.writeFileSync(appBinary, "");
});
afterAll(() => fs.rmSync(path.dirname(appBinary), { recursive: true, force: true }));

// The failure paths run killChildEscalating on a stand-in pid.
vi.spyOn(process, "kill").mockImplementation(() => true);

beforeEach(() => {
  spawnMock.mockReset();
});

describe("bootElectronApp onProcessGone / label", () => {
  it("fires once the child exits, not when boot fails while it is still alive", async () => {
    const child = makeFakeChild(12345);
    spawnMock.mockReturnValue(child);
    const gone = vi.fn();

    const err = await bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 50,
      label: "Browser",
      onProcessGone: gone,
    }).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/^Browser CDP never became reachable on port 1/);
    expect(gone).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("fires when spawn yields no process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      spawnMock.mockReturnValue(makeFakeChild());
      const gone = vi.fn();
      const settled = bootElectronApp({
        appPath: appBinary,
        port: UNREACHABLE_CDP_PORT,
        label: "Browser",
        onProcessGone: gone,
      }).catch((e: unknown) => e);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(1000);
      expect(((await settled) as Error).message).toMatch(
        /^Browser boot: spawn returned without a pid/
      );
      expect(gone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires when spawn throws synchronously", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });
    const gone = vi.fn();
    const err = await bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      label: "Browser",
      onProcessGone: gone,
    }).catch((e: unknown) => e);
    expect(gone).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toMatch(/^Browser boot: failed to spawn/);
  });

  it("fires when boot fails before spawning", async () => {
    const gone = vi.fn();
    const err = await bootElectronApp({
      appPath: path.join(path.dirname(appBinary), "missing"),
      port: UNREACHABLE_CDP_PORT,
      onProcessGone: gone,
    }).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
    );
    expect((err as Error).message).toMatch(/^Electron boot: path does not exist/);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("names the label when the spawn errors or the child exits before CDP is ready", async () => {
    const failed = makeFakeChild(12345);
    spawnMock.mockReturnValue(failed);
    const spawnErr = bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      label: "Browser",
    }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    failed.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    expect(((await spawnErr) as Error).message).toMatch(
      /^Browser boot: failed to launch .* \(EACCES\)/
    );

    const exited = makeFakeChild(12346);
    spawnMock.mockReturnValue(exited);
    const exitErr = bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      label: "Browser",
    }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    exited.emit("exit", 13, null);
    expect(((await exitErr) as Error).message).toMatch(
      /^Browser boot: child process exited with code 13 before CDP was ready/
    );
  });

  it("refuses a second boot on a fixed port while the first is still starting", async () => {
    const child = makeFakeChild(12345);
    spawnMock.mockReturnValue(child);
    const first = bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      readyTimeoutMs: 200,
    }).catch((e: unknown) => e);
    const gone = vi.fn();
    const second = await bootElectronApp({
      appPath: appBinary,
      port: UNREACHABLE_CDP_PORT,
      label: "Browser",
      onProcessGone: gone,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(second)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
    expect(gone).toHaveBeenCalledTimes(1);
    await first;
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a fixed port something already answers on, without spawning", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as net.AddressInfo;
    const gone = vi.fn();
    try {
      const err = await bootElectronApp({
        appPath: appBinary,
        port,
        label: "Browser",
        onProcessGone: gone,
      }).catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
      expect((err as Error).message).toContain(
        `Browser boot: port ${port} is already in use on 127.0.0.1.`
      );
      expect((err as Error).message).toContain(`drive that one as chromium-cdp-${port};`);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(gone).toHaveBeenCalledTimes(1);
    } finally {
      holder.close();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
      await vi.advanceTimersByTimeAsync(1000);
      expect(((await settled) as Error).message).toMatch(/^Browser boot: spawn returned without a pid/);
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
      onProcessGone: gone,
    }).catch((e: unknown) => e);
    expect(gone).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toMatch(/^Electron boot: failed to spawn/);
  });
});

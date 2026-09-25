import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import type { ChildProcess } from "node:child_process";
import type { DeviceInfo } from "@argent/registry";
import type { IosEndpoint } from "../../src/utils/ios-host";

/**
 * A daemon stand-in: dials the blueprint's socket like the real ax-service
 * and answers each command from `answers`, or not at all for a command whose
 * answer is `HANG`.
 */
const HANG = Symbol("hang");
const answers = new Map<string, unknown>();
const daemons: net.Socket[] = [];

function fakeDaemon(endpoint: IosEndpoint): ChildProcess {
  if (endpoint.transport !== "unix") throw new Error("unix only here");
  const proc = new EventEmitter() as ChildProcess & { killed: boolean };
  proc.killed = false;
  Object.assign(proc, {
    kill: () => {
      proc.killed = true;
      return true;
    },
    stdout: null,
    stderr: null,
  });
  const socket = net.connect(endpoint.socketPath);
  daemons.push(socket);
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      const { id, command } = JSON.parse(line) as { id: number; command: string };
      const answer = answers.get(command);
      if (answer === HANG) continue;
      socket.write(JSON.stringify({ id, result: answer ?? { error: "unknown_command" } }) + "\n");
    }
  });
  return proc;
}

vi.mock("../../src/utils/ios-host", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-host")>(
    "../../src/utils/ios-host"
  );
  return {
    ...actual,
    pickIosHost: () => ({
      kind: "local",
      requiresTcp: false,
      bootstrapAx: async () => ({ entitlementBypassActive: true }),
      spawnAxDaemon: (_udid: string, endpoint: IosEndpoint) => fakeDaemon(endpoint),
      startProxy: async () => {},
      stopProxy: async () => {},
    }),
  };
});

import { axServiceBlueprint, type AXServiceApi } from "../../src/blueprints/ax-service";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const device: DeviceInfo = { id: DUO, platform: "ios", kind: "simulator" };

const disposers: Array<() => Promise<void>> = [];

async function attach(): Promise<AXServiceApi> {
  const instance = await axServiceBlueprint.factory({}, device, { device });
  disposers.push(instance.dispose);
  return instance.api;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) await dispose();
  for (const socket of daemons.splice(0)) socket.destroy();
  answers.clear();
});

describe("ax-service livePanel", () => {
  it("asks the daemon for the live panel and answers its display id", async () => {
    answers.set("live_panel", { displayId: 3 });
    const api = await attach();
    expect(await api.livePanel()).toBe(3);
    answers.set("live_panel", { displayId: 1 });
    expect(await api.livePanel()).toBe(1);
  });

  it("answers null when the daemon names no panel", async () => {
    answers.set("live_panel", { displayId: null });
    const api = await attach();
    expect(await api.livePanel()).toBeNull();
    answers.set("live_panel", {});
    expect(await api.livePanel()).toBeNull();
  });

  it("fails on a daemon that predates the command, so the caller falls back", async () => {
    // An older daemon answers `unknown_command` to what it does not know.
    const api = await attach();
    await expect(api.livePanel()).rejects.toThrow(/unknown_command/);
  });

  it("gives up on a daemon that does not answer within its short budget", async () => {
    answers.set("live_panel", HANG);
    const api = await attach();
    vi.useFakeTimers();
    const read = api.livePanel();
    const failure = expect(read).rejects.toThrow(/timed out: live_panel/);
    await vi.advanceTimersByTimeAsync(2_000);
    await failure;
  });
});

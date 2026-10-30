import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import type { ChildProcess } from "node:child_process";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import type { IosEndpoint } from "../../src/utils/ios-host";

/**
 * A daemon stand-in: dials the blueprint's socket like the real ax-service
 * and answers each command from `answers`, or not at all for a command whose
 * answer is `HANG`.
 */
const HANG = Symbol("hang");
const answers = new Map<string, unknown>();
const daemons: net.Socket[] = [];
/** Each request envelope's `params`, by command. */
const received: Array<{ command: string; params?: unknown }> = [];
/** An answer that fails the envelope with this code, as the daemon's own errors do. */
const envelopeError = (code: string) => ({ __envelopeError: code });

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
      const { id, command, params } = JSON.parse(line) as {
        id: number;
        command: string;
        params?: unknown;
      };
      received.push({ command, params });
      const answer = answers.get(command);
      if (answer === HANG) continue;
      const failed = (answer as { __envelopeError?: string } | undefined)?.__envelopeError;
      // A command the daemon does not know fails the whole envelope, as the real one does.
      const reply =
        answer === undefined
          ? { id, error: "unknown_command", result: { error: "unknown_command" } }
          : failed
            ? { id, error: failed, result: { error: failed } }
            : { id, result: answer };
      socket.write(JSON.stringify(reply) + "\n");
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
  received.length = 0;
});

describe("ax-service fill", () => {
  it("sends the text as params and answers the daemon's verdict, never text", async () => {
    answers.set("fill", { verified: true, fillVersion: 1 });
    const api = await attach();
    expect(await api.fill("hello")).toEqual({ focused: true, verified: true });
    expect(received.at(-1)).toEqual({ command: "fill", params: { text: "hello" } });
  });

  it("sends check only when asked", async () => {
    answers.set("fill", { verified: false });
    const api = await attach();
    expect(await api.fill("", { check: true })).toEqual({
      focused: true,
      verified: false,
    });
    expect(received.at(-1)).toEqual({ command: "fill", params: { text: "", check: true } });
  });

  it("passes on the secure and needsBackspace hints", async () => {
    answers.set("fill", { verified: false, secure: true, needsBackspace: true });
    const api = await attach();
    expect(await api.fill("x")).toEqual({
      focused: true,
      verified: false,
      secure: true,
      needsBackspace: true,
    });
  });

  it.each(["no_focused_field", "not_editable"])("answers focused: false for %s", async (code) => {
    answers.set("fill", envelopeError(code));
    const api = await attach();
    expect(await api.fill("x")).toEqual({ focused: false, verified: false });
  });

  it("fails, saying to update argent, on a daemon that predates the command", async () => {
    const api = await attach();
    await expect(api.fill("x")).rejects.toThrow(/predates `fill`; update argent/);
  });

  it("answers unsupported for a focused element that is no text input", async () => {
    answers.set("fill", envelopeError("unsupported_field"));
    const api = await attach();
    expect(await api.fill("x")).toEqual({ focused: true, verified: false, unsupported: true });
  });

  it("answers not verified for fill_failed", async () => {
    answers.set("fill", envelopeError("fill_failed"));
    const api = await attach();
    expect(await api.fill("x")).toEqual({ focused: true, verified: false });
  });

  it("answers untouched for select_failed", async () => {
    answers.set("fill", envelopeError("select_failed"));
    const api = await attach();
    expect(await api.fill("x")).toEqual({ focused: true, verified: false, untouched: true });
  });

  it("passes untouched on for a secure field it could not select", async () => {
    answers.set("fill", { verified: false, secure: true, cleared: false, untouched: true });
    const api = await attach();
    expect(await api.fill("x")).toEqual({
      focused: true,
      verified: false,
      secure: true,
      cleared: false,
      untouched: true,
    });
  });

  it.each(["fill_timeout", "fill_busy"])("answers timedOut for %s", async (code) => {
    answers.set("fill", envelopeError(code));
    const api = await attach();
    expect(await api.fill("x")).toEqual({ focused: true, verified: false, timedOut: true });
  });

  it("answers singleLine when the field holds one line", async () => {
    answers.set("fill", envelopeError("single_line"));
    const api = await attach();
    expect(await api.fill("a\nb")).toEqual({ focused: true, verified: false, singleLine: true });
  });

  it("answers timedOut when the daemon does not answer in time", async () => {
    answers.set("fill", HANG);
    const api = await attach();
    vi.useFakeTimers();
    const fill = api.fill("x");
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(fill).resolves.toEqual({ focused: true, verified: false, timedOut: true });
  });

  it("sends typeable only when the caller cannot type the text, and passes cleared on", async () => {
    answers.set("fill", { verified: false, secure: true, cleared: true });
    const api = await attach();
    expect(await api.fill("x", { typeable: false })).toEqual({
      focused: true,
      verified: false,
      secure: true,
      cleared: true,
    });
    expect(received.at(-1)).toEqual({ command: "fill", params: { text: "x", typeable: false } });
    await api.fill("x", { typeable: true });
    expect(received.at(-1)).toEqual({ command: "fill", params: { text: "x" } });
  });

  it("fails on any other daemon error", async () => {
    answers.set("fill", envelopeError("invalid_params"));
    const api = await attach();
    await expect(api.fill("x")).rejects.toThrow("invalid_params");
  });

  it("sends no params on the commands that take none", async () => {
    answers.set("live_panel", { displayId: null });
    const api = await attach();
    await api.livePanel();
    expect(received.at(-1)).toEqual({ command: "live_panel" });
  });
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

describe("ax-service tree", () => {
  it("answers the daemon's nodes, alert state, truncation, front app and orientation", async () => {
    answers.set("tree", {
      alertVisible: true,
      screenFrame: { width: 402, height: 874 },
      nodes: [
        { index: 0, label: "App" },
        { index: 1, parentIndex: 0, covered: true },
      ],
      truncated: true,
      foregroundApp: "com.example.app",
      interfaceOrientation: "landscapeRight",
      treeVersion: 3,
    });
    const api = await attach();
    expect(await api.tree()).toEqual({
      alertVisible: true,
      screenFrame: { width: 402, height: 874 },
      nodes: [
        { index: 0, label: "App" },
        { index: 1, parentIndex: 0, covered: true },
      ],
      truncated: true,
      foregroundApp: "com.example.app",
      interfaceOrientation: "landscapeRight",
      treeVersion: 3,
    });
  });

  it("asks for an argent update on a daemon that predates the command", async () => {
    const api = await attach();
    const err = await api.tree().catch((e: unknown) => e);
    expect((err as Error).message).toBe("ax-service predates `tree`; update argent");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_TREE_UNSUPPORTED);
  });
});

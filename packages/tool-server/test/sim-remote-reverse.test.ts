import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each scripted outcome answers one `sim-remote` call, in order: a string is the
// stderr of a failed (exit 1) call, `null` a success. `latencyMs` delays the answer.
let outcomes: Array<string | null> = [];
let latencyMs = 0;
const calls: string[][] = [];
const callTimes: number[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      _cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push([...args]);
      callTimes.push(Date.now());
      const stderr = outcomes.shift() ?? null;
      setTimeout(() => {
        if (stderr === null) return cb(null, { stdout: "", stderr: "" });
        cb(Object.assign(new Error("Command failed"), { code: 1, stderr, stdout: "" }));
      }, latencyMs);
    },
  };
});

import { reverseStart, reverseStop } from "../src/utils/sim-remote";
import { remoteIosHost } from "../src/utils/ios-host";
import { jsRuntimeDebuggerBlueprint } from "../src/blueprints/js-runtime-debugger";

const UDID = "6F1C3E4A-0000-4000-8000-000000000001";

async function start(port = 37223): Promise<unknown> {
  const p = reverseStart(`remote:${UDID}`, port).then(
    () => undefined,
    (err: unknown) => err
  );
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  outcomes = [];
  latencyMs = 0;
  calls.length = 0;
  callTimes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reverseStart / reverseStop", () => {
  it("drives `sim-remote reverse`, not the deprecated `proxy` alias", async () => {
    outcomes = [null, null];
    expect(await start()).toBeUndefined();
    const stop = reverseStop(`remote:${UDID}`, 37223);
    await vi.runAllTimersAsync();
    await stop;
    expect(calls).toEqual([
      ["reverse", "start", UDID, "37223"],
      ["reverse", "stop", UDID, "37223"],
    ]);
  });

  it("succeeds on the second attempt after a closed tunnel-mux connection", async () => {
    outcomes = ["error: tunnel-mux connection closed", null];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("retries a control send that failed because the connection closed", async () => {
    outcomes = ["error: tunnel-mux control send: connection lost", null];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it.each([
    "error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout",
    "error: port forwarder: POST /rules answered HTTP 502 Bad Gateway",
  ])("retries a forwarder gateway failure (%s)", async (stderr) => {
    outcomes = [stderr, null];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  // Verbatim CLI messages.
  it.each([
    "error: the host's port forwarder has lost its proxy tunnel (HTTP 503); reverse tunnels cannot be set up on this machine until it reconnects",
    "error: the host's port forwarder is unreachable (no answer within 10s); reverse tunnels cannot be set up on this machine",
    "error: the host's port forwarder is unreachable (connection failed); reverse tunnels cannot be set up on this machine",
    "error: port forwarder: POST /rules answered HTTP 400 Bad Request",
    "error: port forwarder: POST /rules answered HTTP 500 Internal Server Error",
    "error: port forwarder: POST /rules answered HTTP 408 Request Timeout",
    "error: the request to sim-router timed out",
    "error: bind ephemeral TCP listener on both loopback families: no port free on each after 10 attempts (last: Address already in use (os error 48))",
  ])("does not retry a forwarder that stays down or refuses (%s)", async (stderr) => {
    outcomes = [stderr, null];
    const err = await start();
    expect((err as Error).message).toBe(`sim-remote reverse start ${UDID} 37223 failed: ${stderr}`);
    expect(calls).toHaveLength(1);
  });

  it("stops after three attempts and throws the last error", async () => {
    outcomes = [
      "error: tunnel-mux connection closed",
      "error: tunnel-mux connection closed",
      "error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout",
      null,
    ];
    const err = await start();
    expect((err as Error).message).toMatch(/HTTP 504 Gateway Timeout$/);
    expect(calls).toHaveLength(3);
  });

  it("starts no retry once the retry window has passed", async () => {
    latencyMs = 9_000;
    outcomes = [
      "error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout",
      "error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout",
      null,
    ];
    expect(await start()).toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
  });

  it("treats an already-active tunnel as started", async () => {
    outcomes = [`error: tunnel already active for ${UDID} port 37223`];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("pauses 0.5 s, then 2 s, between attempts", async () => {
    outcomes = ["error: tunnel-mux connection closed", "error: tunnel-mux connection closed", null];
    expect(await start()).toBeUndefined();
    expect(callTimes.map((t) => t - callTimes[0]!)).toEqual([0, 500, 2_500]);
  });

  it.each([
    [14_500, 2],
    [14_501, 1],
  ])("starts a retry only within 15 s of the first attempt (504 after %i ms)", async (ms, n) => {
    latencyMs = ms;
    outcomes = ["error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout", null];
    await start();
    expect(calls).toHaveLength(n);
  });

  it("swallows a failed stop", async () => {
    outcomes = [`error: no active tunnel for ${UDID} port 37223`];
    const stop = reverseStop(`remote:${UDID}`, 37223);
    await vi.runAllTimersAsync();
    await expect(stop).resolves.toBeUndefined();
  });

  it("treats an already-active tunnel as started after a retry", async () => {
    outcomes = ["error: tunnel-mux connection closed", "error: tunnel already active"];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("callers open the tunnel with `sim-remote reverse`", () => {
  it("remote iOS host", async () => {
    outcomes = [null, null];
    const started = remoteIosHost.startProxy(`remote:${UDID}`, 40001);
    await vi.runAllTimersAsync();
    await started;
    const stopped = remoteIosHost.stopProxy(`remote:${UDID}`, 40001);
    await vi.runAllTimersAsync();
    await stopped;
    expect(calls).toEqual([
      ["reverse", "start", UDID, "40001"],
      ["reverse", "stop", UDID, "40001"],
    ]);
  });

  it("JS runtime debugger on a remote simulator fails with the tunnel's error", async () => {
    vi.useRealTimers();
    const stderr =
      "error: the host's port forwarder is unreachable (connection failed); reverse tunnels cannot be set up on this machine";
    outcomes = [stderr];
    await expect(
      jsRuntimeDebuggerBlueprint.factory({}, `1:remote:${UDID}`, undefined)
    ).rejects.toThrow(`sim-remote reverse start ${UDID} 1 failed: ${stderr}`);
    expect(calls).toEqual([["reverse", "start", UDID, "1"]]);
  });
});

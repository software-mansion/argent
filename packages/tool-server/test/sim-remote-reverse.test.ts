import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each scripted outcome answers one `sim-remote` call, in order: a string is the
// stderr of a failed (exit 1) call, `null` a success. `latencyMs` delays the answer.
let outcomes: Array<string | null> = [];
let latencyMs = 0;
const calls: string[][] = [];

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
      const stderr = outcomes.shift() ?? null;
      setTimeout(() => {
        if (stderr === null) return cb(null, { stdout: "", stderr: "" });
        cb(Object.assign(new Error("Command failed"), { code: 1, stderr, stdout: "" }));
      }, latencyMs);
    },
  };
});

import { reverseStart, reverseStop } from "../src/utils/sim-remote";

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

  it("retries a closed tunnel control channel", async () => {
    outcomes = ["error: tunnel control channel closed", null];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it.each([
    "error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout",
    "error: port forwarder: POST /rules answered HTTP 504",
    "error: port forwarder: POST /rules answered HTTP 502 Bad Gateway",
    "error: port forwarder: POST /rules timed out",
  ])("retries a forwarder gateway failure (%s)", async (stderr) => {
    outcomes = [stderr, null];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it.each([
    "error: port forwarder: POST /rules answered HTTP 503 Service Unavailable",
    "error: port forwarder: POST /rules answered HTTP 503 Service Unavailable (upstream timeout)",
    "error: port forwarder: lost its proxy tunnel",
    "error: port forwarder: lost its proxy tunnel (keepalive timed out)",
    "error: port forwarder: unreachable",
    "error: port forwarder: unreachable (connect timed out)",
    "error: port forwarder: POST /rules answered HTTP 400 Bad Request",
  ])("does not retry a forwarder that stays down or refuses (%s)", async (stderr) => {
    outcomes = [stderr, null];
    const err = await start();
    expect((err as Error).message).toBe(`sim-remote reverse start ${UDID} 37223 failed: ${stderr}`);
    expect(calls).toHaveLength(1);
  });

  it("does not retry an unrelated failure", async () => {
    outcomes = ["error: unauthorized", null];
    expect(await start()).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it("classifies the CLI output, not the port in the argv", async () => {
    outcomes = ["error: port forwarder: POST /rules answered HTTP 504 Gateway Timeout", null];
    expect(await start(503)).toBeUndefined();
    expect(calls).toHaveLength(2);
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

  it("treats an already-active tunnel as started, including after a retry", async () => {
    outcomes = ["error: tunnel-mux connection closed", "error: tunnel already active"];
    expect(await start()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

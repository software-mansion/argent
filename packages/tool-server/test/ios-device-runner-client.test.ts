import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  createRunnerClient,
  RUNNER_COMMAND_TIMEOUT_MS,
  RunnerCommandError,
  waitForRunnerReady,
  type RunnerCommand,
  type RunnerResponseEnvelope,
  type RunnerResponseError,
} from "../src/utils/ios-device/runner-client";
import type { SendRunnerCommandOptions } from "../src/utils/ios-device/runner-route";
import { IosDeviceTransportError } from "../src/utils/ios-device/usbmux-protocol";

const UDID = "00008110-000978540290401E";
const PORT = 8_100;

type SentCommand = { body: RunnerCommand; options: SendRunnerCommandOptions };

const createFakeSend = (script: Array<unknown | Error>) => {
  const sent: SentCommand[] = [];
  const send = vi.fn(
    async (_udid: string, _port: number, body: unknown, options: SendRunnerCommandOptions) => {
      sent.push({ body: body as RunnerCommand, options });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  );
  return { send, sent };
};

const transportError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("http", "socket hang up mid-response", { retryable: true });

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunnerClient", () => {
  it("stamps a fresh argent-prefixed commandId on non-status commands", async () => {
    const { send, sent } = createFakeSend([
      { ok: true, data: { done: true } } satisfies RunnerResponseEnvelope,
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const result = await client.run({ command: "tap", x: 10, y: 20 });

    expect(result).toEqual({ done: true });
    expect(sent[0]?.body.commandId).toMatch(
      /^argent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(send).toHaveBeenCalledWith(UDID, PORT, expect.anything(), expect.anything());
  });

  it("preserves a caller-provided commandId and never stamps status commands", async () => {
    const { send, sent } = createFakeSend([
      { ok: true, data: {} },
      { ok: true, data: {} },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await client.run({ command: "tap", commandId: "argent-known" });
    await client.run({ command: "status", statusCommandId: "argent-known" }, { readOnly: true });

    expect(sent[0]?.body.commandId).toBe("argent-known");
    expect(sent[1]?.body.commandId).toBeUndefined();
  });

  it("uses the 45s default timeout and forwards readOnly to the send layer", async () => {
    const { send, sent } = createFakeSend([
      { ok: true, data: {} },
      { ok: true, data: {} },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await client.run({ command: "snapshot" }, { readOnly: true });
    await client.run({ command: "tap" }, { timeoutMs: 1_234 });

    expect(sent[0]?.options).toEqual({ timeoutMs: RUNNER_COMMAND_TIMEOUT_MS, readOnly: true });
    expect(sent[1]?.options).toEqual({ timeoutMs: 1_234, readOnly: false });
  });

  it("throws a typed RunnerCommandError for ok:false envelopes", async () => {
    const { send } = createFakeSend([
      {
        ok: false,
        error: { code: "ELEMENT_NOT_FOUND", message: "no such element", hint: "run snapshot" },
      },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client
      .run({ command: "tap" })
      .catch((caught: unknown) => caught as RunnerCommandError);

    expect(error).toBeInstanceOf(RunnerCommandError);
    expect((error as RunnerCommandError).code).toBe("ELEMENT_NOT_FOUND");
    // The hint is folded into the message: agent-facing rendering surfaces
    // only .message, so the guidance must live there.
    expect((error as RunnerCommandError).message).toBe("no such element. Hint: run snapshot");
    expect((error as RunnerCommandError).hint).toBe("run snapshot");
    expect((error as RunnerCommandError).retryable).toBe(false);
  });

  it("does not fold the hint twice when the message already carries it", async () => {
    const { send } = createFakeSend([
      {
        ok: false,
        error: {
          code: "ELEMENT_NOT_FOUND",
          message: "no such element. Hint: run snapshot",
          hint: "run snapshot",
        },
      },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client
      .run({ command: "tap" })
      .catch((caught: unknown) => caught as RunnerCommandError);

    expect((error as RunnerCommandError).message).toBe("no such element. Hint: run snapshot");
  });

  it("classifies RUNNER_BUSY as retryable, the runner's explicit try-again verdict", async () => {
    const { send } = createFakeSend([
      { ok: false, error: { code: "RUNNER_BUSY", message: "busy" } satisfies RunnerResponseError },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client
      .run({ command: "tap" })
      .catch((caught: unknown) => caught as RunnerCommandError);

    expect((error as RunnerCommandError).retryable).toBe(true);
    expect((error as RunnerCommandError).message).toBe("busy");
  });

  it("stamps every RunnerCommandError with the runner-command failure signal", async () => {
    const { send } = createFakeSend([
      { ok: false, error: { code: "ELEMENT_NOT_FOUND", message: "no such element" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

    // Telemetry classification (T44): a runner-reported failure must not fall
    // into the registry's unclassified bucket, and it is the runner's verdict,
    // not devicectl's, so it carries the runner-command code. The wire code
    // stays on `.code`.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_COMMAND_FAILED);
    expect(signal?.failure_stage).toBe("ios_device_runner_command");
    expect(signal?.error_kind).toBe("unknown");
    expect((error as RunnerCommandError).code).toBe("ELEMENT_NOT_FOUND");
  });

  it.each([
    ["COMMAND_TIMED_OUT", "timeout"],
    ["TEXT_INPUT_NOT_FOCUSED", "validation"],
    ["APP_BUNDLE_ID_REQUIRED", "validation"],
    ["INVALID_REQUEST", "validation"],
    ["UNSUPPORTED_OPERATION", "validation"],
    ["APP_NOT_AVAILABLE", "unknown"],
    ["RUNNER_WEDGED", "unknown"],
  ] as const)("classifies the runner code %s as error_kind %s", async (code, kind) => {
    const { send } = createFakeSend([{ ok: false, error: { code, message: "refused" } }]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

    // A request the runner refused on its shape or target reads as validation
    // and a watchdog overrun as timeout; every other wire code stays unknown
    // rather than guessing.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_COMMAND_FAILED);
    expect(signal?.error_kind).toBe(kind);
  });

  describe("reactivated pass-through", () => {
    it("copies a success envelope's reactivated marker onto the returned data object", async () => {
      const { send } = createFakeSend([
        {
          ok: true,
          data: { message: "tapped" },
          reactivated: true,
        } satisfies RunnerResponseEnvelope,
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      // The runner re-fronted a backgrounded target before the tap: the flag
      // rides the data object so the tool layer can tell the agent the
      // foreground screen changed underneath the command.
      expect(result).toEqual({ message: "tapped", reactivated: true });
    });

    it("returns the data untouched (same reference) when the envelope has no marker", async () => {
      const data = { message: "tapped" };
      const { send } = createFakeSend([{ ok: true, data } satisfies RunnerResponseEnvelope]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      expect(result).toBe(data);
    });

    it("carries an error envelope's marker onto the RunnerCommandError and its message", async () => {
      const { send } = createFakeSend([
        {
          ok: false,
          error: { code: "COMMAND_FAILED", message: "stale element", hint: "run snapshot" },
          reactivated: true,
        } satisfies RunnerResponseEnvelope,
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap", x: 1, y: 2 })
        .catch((caught: unknown) => caught as RunnerCommandError);

      // The re-front happened before the tap, so the foreground screen changed
      // even though the tap did not land; the agent has to hear that on the
      // failure path too, and only .message reaches it.
      expect(error).toBeInstanceOf(RunnerCommandError);
      expect((error as RunnerCommandError).reactivated).toBe(true);
      expect((error as RunnerCommandError).message).toBe(
        "stale element. The app was re-fronted before the command ran, so the foreground " +
          "screen changed. Hint: run snapshot"
      );
    });

    it("leaves reactivated false and the message untouched on an error envelope without it", async () => {
      const { send } = createFakeSend([
        { ok: false, error: { code: "COMMAND_FAILED", message: "stale element" } },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap", x: 1, y: 2 })
        .catch((caught: unknown) => caught as RunnerCommandError);

      expect((error as RunnerCommandError).reactivated).toBe(false);
      expect((error as RunnerCommandError).message).toBe("stale element");
    });

    it("resurfaces the marker from a journal-retained response", async () => {
      const { send } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "completed",
            responseJson: JSON.stringify({
              ok: true,
              data: { message: "tapped" },
              reactivated: true,
            }),
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      expect(result).toEqual({ message: "tapped", reactivated: true });
    });
  });

  describe("warning pass-through", () => {
    const SUPPRESSED_NOISE_WARNING =
      "accessibility noise was suppressed during this gesture; " +
      "re-observe the screen to confirm the effect.";

    it("copies a success envelope's warning onto the returned data object", async () => {
      const { send } = createFakeSend([
        {
          ok: true,
          data: { message: "tapped" },
          warning: SUPPRESSED_NOISE_WARNING,
        } satisfies RunnerResponseEnvelope,
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      // Success replies have no hint channel, so the runner's advisory rides
      // the data object for the tool layer to surface.
      expect(result).toEqual({ message: "tapped", warning: SUPPRESSED_NOISE_WARNING });
    });

    it("composes with reactivated: one reply carries both markers", async () => {
      const { send } = createFakeSend([
        {
          ok: true,
          data: { message: "tapped" },
          reactivated: true,
          warning: SUPPRESSED_NOISE_WARNING,
        } satisfies RunnerResponseEnvelope,
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      expect(result).toEqual({
        message: "tapped",
        reactivated: true,
        warning: SUPPRESSED_NOISE_WARNING,
      });
    });
  });

  describe("status recovery after a lost mutating-command response", () => {
    it("returns the retained response when the runner reports the command completed", async () => {
      const { send, sent } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "completed",
            responseJson: JSON.stringify({ ok: true, data: { tapped: true } }),
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const result = await client.run({ command: "tap", x: 1, y: 2 });

      // The tap happened; replaying it would tap twice. Recovery returns the
      // response the transport lost instead.
      expect(result).toEqual({ tapped: true });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body).toEqual({
        command: "status",
        statusCommandId: sent[0]?.body.commandId,
      });
      expect(sent[1]?.options).toEqual({ timeoutMs: 3_000, readOnly: true });
    });

    it("surfaces the runner's own error when the runner reports the command failed", async () => {
      const { send } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "failed",
            errorCode: "ELEMENT_NOT_FOUND",
            errorMessage: "target vanished",
            errorHint: "run snapshot",
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap" })
        .catch((caught: unknown) => caught as RunnerCommandError);

      expect(error).toBeInstanceOf(RunnerCommandError);
      expect((error as RunnerCommandError).code).toBe("ELEMENT_NOT_FOUND");
      expect((error as RunnerCommandError).message).toBe("target vanished. Hint: run snapshot");
      expect((error as RunnerCommandError).hint).toBe("run snapshot");
    });

    it("rethrows the transport error when the journal state is unknown", async () => {
      const original = transportError();
      const { send } = createFakeSend([original, { ok: true, data: { state: "started" } }]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
      // The rethrown object is stamped IN PLACE (T44); identity above proves
      // the stamp cannot have replaced the error callers compare against. The
      // exchange failed against a runner that was reachable, so this is a
      // transport failure, not a runner that never became ready.
      const signal = getFailureSignal(error);
      expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_TRANSPORT_FAILED);
      expect(signal?.failure_stage).toBe("ios_device_runner_transport");
      expect(signal?.error_kind).toBe("network");
    });

    it("rethrows the transport error when the status probe itself fails", async () => {
      const original = transportError();
      const { send, sent } = createFakeSend([original, transportError()]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
      expect(sent).toHaveLength(2);
    });

    it("rethrows the transport error when completed but no response was retained", async () => {
      const original = transportError();
      const { send } = createFakeSend([original, { ok: true, data: { state: "completed" } }]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
    });

    it("does not attempt recovery for read-only commands", async () => {
      const original = transportError();
      const { send, sent } = createFakeSend([original]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "snapshot" }, { readOnly: true })
        .catch((caught: unknown) => caught);

      // The send layer already retried idempotent sends; a status probe
      // could tell us nothing a retry did not.
      expect(error).toBe(original);
      expect(sent).toHaveLength(1);
    });

    it.each([
      ["device-unattached", false],
      ["runner-not-listening", true],
    ] as const)(
      "does not attempt recovery for the pre-send kind %s: one send, original error rethrown",
      async (kind, retryable) => {
        const original = new IosDeviceTransportError(kind, "usbmux connect failed", { retryable });
        const { send, sent } = createFakeSend([original]);
        const client = createRunnerClient({ udid: UDID, port: PORT, send });

        const error = await client
          .run({ command: "tap", x: 1, y: 2 })
          .catch((caught: unknown) => caught);

        // The usbmux connection never opened: the tap cannot have landed, and
        // a status probe would ride the same dead route.
        expect(error).toBe(original);
        expect(sent).toHaveLength(1);
        // Pre-send kinds are user-reachable too, so they carry the stamp; no
        // runner was reached at all, so they keep the not-ready code.
        const signal = getFailureSignal(error);
        expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
        expect(signal?.failure_stage).toBe("ios_device_runner_transport");
      }
    );

    it("still attempts recovery for a post-send timeout: the command may have run", async () => {
      const original = new IosDeviceTransportError("timeout", "HTTP exchange timed out", {
        retryable: false,
      });
      const { send, sent } = createFakeSend([original, { ok: true, data: { state: "started" } }]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client.run({ command: "tap" }).catch((caught: unknown) => caught);

      expect(error).toBe(original);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body.command).toBe("status");
      // A mid-session timeout on a ready runner is a transport failure with
      // the timeout kind, not a runner that never became ready.
      const signal = getFailureSignal(error);
      expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_TRANSPORT_FAILED);
      expect(signal?.error_kind).toBe("timeout");
    });

    it("surfaces the retained ok:false envelope as the command's real outcome", async () => {
      const { send } = createFakeSend([
        transportError(),
        {
          ok: true,
          data: {
            state: "completed",
            responseJson: JSON.stringify({
              ok: false,
              error: { code: "RUNNER_BUSY", message: "was busy" },
            }),
          },
        },
      ]);
      const client = createRunnerClient({ udid: UDID, port: PORT, send });

      const error = await client
        .run({ command: "tap" })
        .catch((caught: unknown) => caught as RunnerCommandError);

      expect(error).toBeInstanceOf(RunnerCommandError);
      expect((error as RunnerCommandError).code).toBe("RUNNER_BUSY");
      expect((error as RunnerCommandError).retryable).toBe(true);
    });
  });
});

describe("waitForRunnerReady", () => {
  it("polls status every 250ms until the first parsed response", async () => {
    vi.useFakeTimers();
    const { send, sent } = createFakeSend([
      transportError(),
      transportError(),
      { ok: true, data: { uptimeMs: 12, state: "idle" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 10_000 });
    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toHaveLength(3);
    expect(sent.every((entry) => entry.body.command === "status")).toBe(true);
    expect(sent.every((entry) => entry.options.readOnly === true)).toBe(true);
  });

  it("treats a parsed ok:false answer as ready: the transport provably works", async () => {
    const { send, sent } = createFakeSend([
      { ok: false, error: { code: "RUNNER_BUSY", message: "busy" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    await waitForRunnerReady(client, { timeoutMs: 10_000 });

    expect(sent).toHaveLength(1);
  });

  it("keeps polling when the answer is not an envelope at all", async () => {
    vi.useFakeTimers();
    // The port comes from pickFreePort and the runner binds it only later, so
    // anything else that grabbed it in between answers HTTP without speaking
    // the envelope. Accepting that would end the 120s wait in success and
    // leave the first real command to fail.
    const { send, sent } = createFakeSend([
      { result: "some other listener" },
      { ok: true, data: { state: "idle" } },
    ]);
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 10_000 });
    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toHaveLength(2);
  });

  it("times out with a typed error when only non-envelope answers come back", async () => {
    vi.useFakeTimers();
    const { send } = createFakeSend(Array.from({ length: 50 }, () => ({ result: "not mine" })));
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 1_000 }).catch(
      (caught: unknown) => caught
    );
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("timeout");
    // The last unrecognized answer is kept as the cause, so the timeout names
    // what was actually on the port.
    expect((error as IosDeviceTransportError).cause).toBeInstanceOf(RunnerCommandError);
  });

  it("times out with a typed error when the runner never answers", async () => {
    vi.useFakeTimers();
    const { send } = createFakeSend(Array.from({ length: 50 }, () => transportError()));
    const client = createRunnerClient({ udid: UDID, port: PORT, send });

    const pending = waitForRunnerReady(client, { timeoutMs: 1_000 }).catch(
      (caught: unknown) => caught
    );
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("timeout");
    expect(send.mock.calls.length).toBeGreaterThan(1);
    // The ready-timeout is user-reachable when the child is still alive. It
    // is the one timeout that genuinely means not ready: no first envelope
    // ever came, so it must not read as a mid-session transport failure (T44).
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
    expect(signal?.failure_stage).toBe("ios_device_runner_ready_poll");
    expect(signal?.error_kind).toBe("timeout");
  });
});

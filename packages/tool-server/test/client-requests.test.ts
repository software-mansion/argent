import { describe, it, expect, vi, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type ClientRequestLine } from "@argent/registry";
import {
  ClientRequestBroker,
  isClientRequestAbort,
  isClientRequestFailure,
} from "../src/client-requests";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Settles into the rejection reason without letting it escape as unhandled. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (err: unknown) => err
  );
}

function openBroker(invocation = "inv-1"): {
  broker: ClientRequestBroker;
  lines: ClientRequestLine[];
} {
  const broker = new ClientRequestBroker();
  const lines: ClientRequestLine[] = [];
  broker.open(invocation, (line) => lines.push(line));
  return { broker, lines };
}

describe("ClientRequestBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes one request line and resolves with the answer body without id and ok", async () => {
    const { broker, lines } = openBroker();
    const args = { anchorDir: "/proj/flows", target: "login.yaml", kind: "flow" };

    const pending = broker.request("inv-1", "resolve-file", args, 30_000);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: "client-request",
      invocation: "inv-1",
      id: expect.stringMatching(UUID),
      op: "resolve-file",
      args,
    });

    const verdict = broker.answer("inv-1", {
      id: lines[0]!.id,
      ok: true,
      canonical: "/proj/flows/login.yaml",
      exists: true,
      content: "YQ==",
    });
    expect(verdict).toBe("accepted");
    await expect(pending).resolves.toEqual({
      canonical: "/proj/flows/login.yaml",
      exists: true,
      content: "YQ==",
    });

    // A second request gets its own id.
    broker.request("inv-1", "list-dir", { path: "/proj/flows" }, 30_000).catch(() => {});
    expect(lines).toHaveLength(2);
    expect(lines[1]!.id).not.toBe(lines[0]!.id);
    broker.close("inv-1");
  });

  it("rejects with client_request_timeout when no answer arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    const { broker, lines } = openBroker();
    const pending = broker.request("inv-1", "list-dir", { path: "/proj/flows" }, 30_000);
    let settled = false;
    const outcome = rejectionOf(pending).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(settled).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'the client did not answer the list-dir request for "/proj/flows" within 30 s'
    );
    expect(getFailureSignal(err)).toEqual({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "client_request_timeout",
      failure_area: "tool_server",
      error_kind: "validation",
    });
    expect(isClientRequestFailure(err)).toBe(true);
    expect(isClientRequestAbort(err)).toBe(false);

    // The id is forgotten on timeout: a late answer is unknown, not a duplicate.
    expect(broker.answer("inv-1", { id: lines[0]!.id, ok: true })).toBe("unknown_request");

    // The message falls back to the op when the args name neither target nor path.
    const bare = rejectionOf(broker.request("inv-1", "run-script", { step: 3 }, 2_500));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(((await bare) as Error).message).toBe(
      'the client did not answer the run-script request for "run-script" within 3 s'
    );
    broker.close("inv-1");
  });

  it("rejects with client_request_refused when the answer carries ok: false", async () => {
    const { broker, lines } = openBroker();
    const pending = broker.request(
      "inv-1",
      "resolve-file",
      { anchorDir: "/proj", target: "../outside.yaml", kind: "flow" },
      30_000
    );

    expect(
      broker.answer("inv-1", {
        id: lines[0]!.id,
        ok: false,
        error: "the path lies outside every root",
      })
    ).toBe("accepted");

    const err = await rejectionOf(pending);
    expect((err as Error).message).toBe(
      'the client refused the resolve-file request for "../outside.yaml": the path lies outside every root'
    );
    expect(getFailureSignal(err)).toEqual({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "client_request_refused",
      failure_area: "tool_server",
      error_kind: "validation",
    });
    expect(isClientRequestFailure(err)).toBe(true);
    expect(isClientRequestAbort(err)).toBe(false);
    broker.close("inv-1");
  });

  it("returns duplicate for a second answer to the same id", async () => {
    const { broker, lines } = openBroker();
    const pending = broker.request("inv-1", "list-dir", { path: "/proj" }, 30_000);
    const id = lines[0]!.id;

    expect(broker.answer("inv-1", { id, ok: true, entries: ["a.yaml"] })).toBe("accepted");
    expect(broker.answer("inv-1", { id, ok: true, entries: ["b.yaml"] })).toBe("duplicate");
    expect(broker.answer("inv-1", { id, ok: false, error: "late refusal" })).toBe("duplicate");

    // The first answer stands.
    await expect(pending).resolves.toEqual({ entries: ["a.yaml"] });
    broker.close("inv-1");
  });

  it("returns unknown_request for an unknown id and unknown_invocation for an unknown invocation", () => {
    const { broker } = openBroker();
    broker.request("inv-1", "list-dir", { path: "/proj" }, 30_000).catch(() => {});

    expect(broker.answer("inv-1", { id: "never-minted", ok: true })).toBe("unknown_request");
    expect(broker.answer("inv-2", { id: "never-minted", ok: true })).toBe("unknown_invocation");
    broker.close("inv-1");
  });

  it("rejects every pending request with an AbortError on close", async () => {
    vi.useFakeTimers();
    const { broker, lines } = openBroker();
    const first = broker.request("inv-1", "resolve-file", { target: "a.yaml" }, 30_000);
    const second = broker.request("inv-1", "list-dir", { path: "/proj" }, 30_000);
    // Nobody ever awaits this one: close must not raise an unhandled rejection.
    void broker.request("inv-1", "list-dir", { path: "/proj/ignored" }, 30_000);
    expect(lines).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(3);

    broker.close("inv-1");

    const errors = (await Promise.all([rejectionOf(first), rejectionOf(second)])) as Error[];
    expect(errors.map((err) => err.name)).toEqual(["AbortError", "AbortError"]);
    expect(errors[0]!.message).toBe(
      "the client disconnected before answering the resolve-file request"
    );
    expect(errors[1]!.message).toBe(
      "the client disconnected before answering the list-dir request"
    );
    expect(errors.every((err) => isClientRequestAbort(err))).toBe(true);
    expect(errors.some((err) => isClientRequestFailure(err))).toBe(false);
    expect(errors.some((err) => getFailureSignal(err) !== null)).toBe(false);

    // Every timer is cleared and the invocation is forgotten.
    expect(vi.getTimerCount()).toBe(0);
    expect(broker.answer("inv-1", { id: lines[0]!.id, ok: true })).toBe("unknown_invocation");
    // Closing again is a no-op.
    expect(() => broker.close("inv-1")).not.toThrow();
  });

  it("rejects a request made after close", async () => {
    const { broker, lines } = openBroker();
    broker.close("inv-1");

    const afterClose = await rejectionOf(
      broker.request("inv-1", "resolve-file", { target: "a.yaml" }, 30_000)
    );
    expect((afterClose as Error).name).toBe("AbortError");
    expect(isClientRequestAbort(afterClose)).toBe(true);
    // Nothing is written for a closed invocation.
    expect(lines).toHaveLength(0);

    // The same for an invocation that was never opened.
    const neverOpened = await rejectionOf(
      broker.request("inv-9", "list-dir", { path: "/proj" }, 30_000)
    );
    expect((neverOpened as Error).name).toBe("AbortError");
    expect((neverOpened as Error).message).toBe(
      "the client disconnected before answering the list-dir request"
    );
  });
});

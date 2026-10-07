/**
 * The broker behind client services: one pending answer per request the
 * tool-server asks the client during a streamed tool call.
 *
 * A request is one `client-request` line on the call's NDJSON stream; the
 * client answers it on a separate HTTP request
 * (`POST /invocations/:invocation/client-responses`), which the route hands to
 * {@link ClientRequestBroker.answer}. The broker keeps no queue: it holds one
 * promise per request id, settles it on the answer or the timeout, and rejects
 * every pending promise when the call's response closes. A client that let one
 * request time out is not answering: every later request of the same call fails
 * at once instead of waiting out a timeout of its own. The next call starts
 * afresh.
 */

import { randomUUID } from "node:crypto";
import {
  CLIENT_REQUEST_EVENT,
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type ClientRequestLine,
  type ClientResponseBody,
  type ClientServiceOp,
} from "@argent/registry";

type ClientAnswerVerdict = "accepted" | "unknown_invocation" | "unknown_request" | "duplicate";

interface PendingRequest {
  op: ClientServiceOp;
  /** The target or path the request names, for the failure messages. */
  subject: string;
  resolve: (body: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface OpenInvocation {
  write: (line: ClientRequestLine) => void;
  pending: Map<string, PendingRequest>;
  /** Ids that already got an answer, kept until close so a repeat is a duplicate. */
  answered: Set<string>;
  /** The timeout of the first unanswered request; later requests fail with it at once. */
  silent?: FailureError;
}

function requestSubject(op: ClientServiceOp, args: Record<string, unknown>): string {
  if (typeof args.target === "string") return args.target;
  if (typeof args.path === "string") return args.path;
  return op;
}

function abortError(op: ClientServiceOp): Error {
  const err = new Error(`the client disconnected before answering the ${op} request`);
  err.name = "AbortError";
  return err;
}

function refusalFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.FLOW_FILE_INVALID,
    failure_stage: "client_request_refused",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * The client went quiet: a transport failure, not a fault of the flow, so it is
 * a timeout and not a validation error. Before step 1 (the request for the root
 * flow, or the scan of a leading `run:` chain) it ends the call, and a
 * directory run stops on it. At a `run:` or `snapshot` step it fails only that
 * step, in an ordinary report, so a directory run goes on, to stop only if the
 * next flow's own first request times out too: the fail-fast below is per
 * call. The message names what keeps answers from arriving. A request that
 * carries a file, out or back, has to move it within the same timeout, so its
 * message names a slow connection too.
 */
function notAnsweringFailure(
  op: ClientServiceOp,
  subject: string,
  timeoutMs: number
): FailureError {
  const seconds = Math.round(timeoutMs / 1000);
  const transfer =
    op === "read-file" || op === "write-file"
      ? ` The ${seconds} s include moving the file, so a connection too slow for its size ` +
        `times out too.`
      : "";
  return new FailureError(
    `the client did not answer the ${op} request for "${subject}" within ` +
      `${seconds} s. The client has to keep running, and its answers have ` +
      `to reach this tool-server, until the run ends: a paused or sleeping client, a reverse ` +
      `proxy that buffers the call's response stream, or a proxy that does not forward ` +
      `POST /invocations/<invocation>/client-responses stops them.${transfer}`,
    {
      error_code: FAILURE_CODES.FLOW_CLIENT_NOT_ANSWERING,
      failure_stage: "client_request_timeout",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

export class ClientRequestBroker {
  private readonly invocations = new Map<string, OpenInvocation>();

  /** Start serving requests for one invocation. `write` writes one NDJSON line. */
  open(invocation: string, write: (line: ClientRequestLine) => void): void {
    this.invocations.set(invocation, { write, pending: new Map(), answered: new Set() });
  }

  /** Write a request line and wait for its answer. */
  request(
    invocation: string,
    op: ClientServiceOp,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const entry = this.invocations.get(invocation);
    const subject = requestSubject(op, args);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!entry) {
        reject(abortError(op));
        return;
      }
      if (entry.silent) {
        reject(entry.silent);
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        entry.silent = notAnsweringFailure(op, subject, timeoutMs);
        reject(entry.silent);
      }, timeoutMs);
      timer.unref?.();
      entry.pending.set(id, { op, subject, resolve, reject, timer });
      try {
        entry.write({ event: CLIENT_REQUEST_EVENT, invocation, id, op, args });
      } catch (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // A rejection with no consumer (the caller gave up on the call) must not
    // surface as an unhandled rejection; the caller still observes it through
    // the promise returned here.
    promise.catch(() => {});
    return promise;
  }

  /** Deliver an answer. */
  answer(invocation: string, body: ClientResponseBody): ClientAnswerVerdict {
    const entry = this.invocations.get(invocation);
    if (!entry) return "unknown_invocation";
    if (entry.answered.has(body.id)) return "duplicate";
    const pending = entry.pending.get(body.id);
    if (!pending) return "unknown_request";
    clearTimeout(pending.timer);
    entry.pending.delete(body.id);
    entry.answered.add(body.id);
    if (body.ok === false) {
      pending.reject(
        refusalFailure(
          `the client refused the ${pending.op} request for "${pending.subject}": ${body.error}`
        )
      );
    } else {
      const { id: _id, ok: _ok, ...payload } = body;
      pending.resolve(payload);
    }
    return "accepted";
  }

  /** Reject every pending request with an AbortError and forget the invocation. */
  close(invocation: string): void {
    const entry = this.invocations.get(invocation);
    if (!entry) return;
    this.invocations.delete(invocation);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(abortError(pending.op));
    }
    entry.pending.clear();
  }
}

/** True for the rejection the broker raises when the call's response closed. */
export function isClientRequestAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** True for a request the client did not answer in time (the channel itself is broken). */
export function isClientRequestTimeout(err: unknown): boolean {
  return getFailureSignal(err)?.failure_stage === "client_request_timeout";
}

/** True for a request the client answered with a refusal (the channel itself is fine). */
export function isClientRequestRefusal(err: unknown): boolean {
  return getFailureSignal(err)?.failure_stage === "client_request_refused";
}

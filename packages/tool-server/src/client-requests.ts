/**
 * The broker behind client services: one pending answer per request the
 * tool-server asks the client during a streamed tool call.
 *
 * A request is one `client-request` line on the call's NDJSON stream; the
 * client answers it on a separate HTTP request
 * (`POST /invocations/:invocation/client-responses`), which the route hands to
 * {@link ClientRequestBroker.answer}. The broker keeps no queue: it holds one
 * promise per request id, settles it on the answer or the timeout, and rejects
 * every pending promise when the call's response closes.
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
}

const REQUEST_FAILURE_STAGES = new Set(["client_request_timeout", "client_request_refused"]);

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

function requestFailure(message: string, stage: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.FLOW_FILE_INVALID,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: "validation",
  });
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
      const id = randomUUID();
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(
          requestFailure(
            `the client did not answer the ${op} request for "${subject}" within ` +
              `${Math.round(timeoutMs / 1000)} s`,
            "client_request_timeout"
          )
        );
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
        requestFailure(
          `the client refused the ${pending.op} request for "${pending.subject}": ${body.error}`,
          "client_request_refused"
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

/** True for a request that timed out or that the client refused. */
export function isClientRequestFailure(err: unknown): boolean {
  const stage = getFailureSignal(err)?.failure_stage;
  return stage !== undefined && REQUEST_FAILURE_STAGES.has(stage);
}

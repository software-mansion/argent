/**
 * A tool invocation the SERVER answered with an error — an HTTP error status or
 * the NDJSON stream's terminal `error` line — or one whose connection closed
 * after the call was sent, so that the tool may have run. A file input whose
 * upload was refused fails the same way, before the call is sent.
 * `errorKind`/`errorCode` carry the server's failure signal (e.g. kind
 * "validation") when it sent one.
 *
 * `issues` is the issue list a 400 carries beside its prose message, so a caller
 * can map a rejected field back to the flag its user typed. Undefined for an
 * older server.
 */
export class ToolInvocationError extends Error {
  readonly errorCode?: string;
  readonly errorKind?: string;
  readonly issues?: readonly unknown[];
  constructor(
    message: string,
    signal?: { errorCode?: string; errorKind?: string; issues?: readonly unknown[] },
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ToolInvocationError";
    this.errorCode = signal?.errorCode;
    this.errorKind = signal?.errorKind;
    this.issues = signal?.issues;
  }
}

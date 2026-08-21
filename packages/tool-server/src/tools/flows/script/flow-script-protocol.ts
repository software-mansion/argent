/**
 * The IPC protocol between the flow script executor (the parent, in this
 * package) and `flow-script-runner.mjs` (the child it forks).
 *
 * Three messages cross the channel in a passing run: the parent's `execute`
 * request, and the child's `started` followed by one terminal response. Script
 * logs never travel here — they ride stdout/stderr, so that
 * console text and any subprocess the script starts land in one stream in
 * written order, and so that a limit can apply while draining rather than after
 * a whole message has been serialized.
 *
 * **Two rules the brief gives the parent are deliberately not implemented, and
 * this is where that decision is recorded.** A response that arrives
 * after the child's exit is honoured rather than rejected: the message handler
 * stays attached through the settle race, and a verdict the child sent before
 * dying is still that child's verdict — Node simply delivered it late. And
 * there is no `disconnect` handler on the parent's side: with the channel now
 * out of the script's reach, a channel that closes without the process exiting
 * has no path left to happen through, and a runner that truly wedges is
 * reported by the step's time limit.
 *
 * **There is no version field.** Both sides ship in the same package from the
 * same installation, so the two can never disagree, and nothing keeps a message
 * after the run. Adding a version later costs one change to two files that
 * already ship together.
 */

/** 1 MiB of encoded output. The child enforces it; the parent re-checks. */
export const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Ceilings on the two free-text fields of a `failure`, so that every field that
 * crosses this channel is bounded. An error message is script-controlled —
 * `throw new Error(\`Unexpected response: \${await res.text()}\`)` puts a whole
 * response body in one — and an IPC message is deserialized whole into the
 * parent's heap before anything can look at it, so the ceiling has to be
 * applied by the sender. The child enforces both; the parent re-checks, as it
 * does for the output size, because it must not depend on a child staying
 * compliant after arbitrary script code has run inside it. `flow-script-runner.mjs`
 * keeps its own copy of these numbers — it imports nothing from this package.
 */
export const SCRIPT_MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
export const SCRIPT_MAX_FAILURE_STACK_CHARS = 16 * 1024;

/** Parent → child. Sent once, immediately after the fork. */
export interface ScriptExecuteRequest {
  type: "execute";
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  /** The current flow output, already encoded. `"{}"` when the flow has none yet. */
  outputJson: string;
  /** The child's own copy of the hard time limit, for its deadline watchdog. */
  deadlineMs: number;
  /** The encoded-output ceiling the child enforces. */
  maxOutputBytes: number;
}

/**
 * Why a script did not produce output, as the child sees it.
 *
 * `load` is a module that never evaluated (missing file, bad syntax, an import
 * Node refused); `runtime` is the script's own code throwing; `output` is a
 * value that cannot cross into flow state; `exit` is the script reporting its
 * own failure through a non-zero exit code; `protocol` is the runner itself
 * failing before or around the script.
 */
export type ScriptFailureType = "load" | "runtime" | "output" | "exit" | "protocol";

/**
 * Child → parent. `started` is load-bearing: it is the only thing that lets the
 * parent tell "the runner never began the script" apart from "the script
 * stopped its own process".
 */
export type ScriptResponse =
  | { type: "started" }
  | { type: "result"; outputJson: string }
  | {
      type: "failure";
      failureType: ScriptFailureType;
      message: string;
      stack?: string;
    };

/** The two responses that end a run. `started` is not one of them. */
export type ScriptTerminalResponse = Exclude<ScriptResponse, { type: "started" }>;

const FAILURE_TYPES: readonly ScriptFailureType[] = [
  "load",
  "runtime",
  "output",
  "exit",
  "protocol",
];

/**
 * Validate one message off the IPC channel.
 *
 * Returns `null` for anything that matches no shape. The parent treats that as
 * a protocol failure rather than coercing it: a script runs arbitrary code, so
 * a malformed message means the runner is no longer behaving, and guessing at
 * its intent is how a wrong verdict reaches the report.
 */
export function parseScriptResponse(raw: unknown): ScriptResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "started":
      return { type: "started" };
    case "result":
      return typeof msg.outputJson === "string"
        ? { type: "result", outputJson: msg.outputJson }
        : null;
    case "failure": {
      const failureType = msg.failureType;
      if (typeof failureType !== "string") return null;
      if (!FAILURE_TYPES.includes(failureType as ScriptFailureType)) return null;
      if (typeof msg.message !== "string") return null;
      return {
        type: "failure",
        failureType: failureType as ScriptFailureType,
        message: msg.message,
        ...(typeof msg.stack === "string" ? { stack: msg.stack } : {}),
      };
    }
    default:
      return null;
  }
}

/** Narrows a response to the two shapes that end a run. */
export function isTerminalResponse(response: ScriptResponse): response is ScriptTerminalResponse {
  return response.type === "result" || response.type === "failure";
}

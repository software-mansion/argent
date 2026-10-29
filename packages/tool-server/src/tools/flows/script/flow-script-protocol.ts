/**
 * The IPC protocol between the flow script executor and the
 * `flow-script-runner.mjs` child it forks: an `execute` request out, then
 * `started` and one terminal response back.
 *
 * Script logs never travel here — they ride stdout/stderr, so that console text
 * and any subprocess the script starts land in one stream in written order, and
 * so that a limit can apply while draining rather than after a whole message
 * has been serialized.
 *
 * `interpreter` picks the runner's mode. In `node` mode it preloads in front of
 * the script and the document crosses this channel both ways. In `bash` mode it
 * spawns bash, which reads and writes the document in the file the request names;
 * the runner reads it back after bash exits and returns it here.
 */

export const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * An error message is script-controlled — a `throw` interpolating a whole
 * response body is the ordinary shape — and an IPC message is deserialized
 * whole into the parent's heap before anything can look at it, so only the
 * sender can bound it. The parent re-checks, because it must not depend on a
 * child staying compliant after arbitrary script code has run inside it.
 * `flow-script-runner.mjs` keeps its own copy — it imports nothing from here.
 */
export const SCRIPT_MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
export const SCRIPT_MAX_FAILURE_STACK_CHARS = 16 * 1024;

type ScriptInterpreter = "node" | "bash";

interface ScriptExecuteCommon {
  type: "execute";
  deadlineMs: number;
  maxOutputBytes: number;
}

interface ScriptExecuteNodeRequest extends ScriptExecuteCommon {
  interpreter: Extract<ScriptInterpreter, "node">;
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  outputJson: string;
}

interface ScriptExecuteBashRequest extends ScriptExecuteCommon {
  interpreter: Extract<ScriptInterpreter, "bash">;
  /** Absolute, resolved by the parent; the runner runs what it is told. */
  interpreterPath: string;
  /** bash's one argument, and `$0`. Forward slashes on every platform. */
  scriptPath: string;
  /** `$ARGENT_OUTPUT`: the document, in and out. Created by the parent. */
  outputFile: string;
  /** What the parent seeded {@link outputFile} with, to tell whether the script wrote it. */
  outputJson: string;
  /**
   * The parent's own time limit, so the runner's wait for a group signal never
   * outlives the parent's timer.
   */
  timeoutMs: number;
}

export type ScriptExecuteRequest = ScriptExecuteNodeRequest | ScriptExecuteBashRequest;

export type ScriptFailureType =
  "load" | "runtime" | "output" | "exit" | "protocol" | "spawn" | "signal";

/**
 * Child → parent. `started` is the only thing that lets the parent tell "the
 * runner never began the script" apart from "the script stopped its own
 * process".
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

export type ScriptTerminalResponse = Exclude<ScriptResponse, { type: "started" }>;

const FAILURE_TYPES: readonly ScriptFailureType[] = [
  "load",
  "runtime",
  "output",
  "exit",
  "protocol",
];

/**
 * Failures only the bash-mode runner can report, since it spawns bash itself.
 * Refused in node mode, where the script runs inside the runner and must not be
 * able to forge a `spawn` ("nothing ran") answer for itself.
 */
const BASH_ONLY_FAILURE_TYPES: readonly ScriptFailureType[] = ["spawn", "signal"];

export function parseScriptResponse(
  raw: unknown,
  interpreter: ScriptInterpreter
): ScriptResponse | null {
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
      const accepted =
        interpreter === "bash" ? [...FAILURE_TYPES, ...BASH_ONLY_FAILURE_TYPES] : FAILURE_TYPES;
      if (!accepted.includes(failureType as ScriptFailureType)) return null;
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

export function isTerminalResponse(response: ScriptResponse): response is ScriptTerminalResponse {
  return response.type === "result" || response.type === "failure";
}

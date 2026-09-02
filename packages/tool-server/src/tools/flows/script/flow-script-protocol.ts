/**
 * The IPC protocol between the flow script executor and the
 * `flow-script-runner.mjs` child it forks: an `execute` request out, then
 * `started` and one terminal response back.
 *
 * What the script PRINTS is not among them, and putting it here would not be a
 * transport decision to make: the executor drains stdout and stderr precisely
 * so that console text never reaches the report, because nothing in a flow file
 * declares what a script prints is safe to forward. A script with something to
 * say has to `throw` it or return it in `output` — both of which travel here,
 * and both of which are bounded by the limits below.
 *
 * The runner has two modes, and `interpreter` is what picks one. In `node` mode
 * it rides in as an `--import` preload in front of the script itself, and the
 * document crosses this channel in both directions. In `bash` mode it is the
 * entry module and spawns bash as its own child, so the document travels
 * through the two files the executor names in the request instead — bash has no
 * IPC channel, and the runner closes its own to what it starts.
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

export interface ScriptExecuteNodeRequest extends ScriptExecuteCommon {
  interpreter: Extract<ScriptInterpreter, "node">;
  /**
   * The script, as the real-path file URL Node resolved its entry module to.
   * The runner re-imports it — a cache hit — to tell a script that finished
   * from one parked inside a top-level `await` that never settles.
   */
  scriptUrl: string;
  outputJson: string;
}

export interface ScriptExecuteBashRequest extends ScriptExecuteCommon {
  interpreter: Extract<ScriptInterpreter, "bash">;
  /** Absolute, resolved by the parent; the runner runs what it is told. */
  interpreterPath: string;
  /** bash's one argument, and `$0`. Forward slashes on every platform. */
  scriptPath: string;
  /** `$ARGENT_OUTPUT`: the document, in and out. Created by the parent. */
  outputFile: string;
  /**
   * What the parent seeded {@link outputFile} with. The runner compares the
   * document it reads back against this, and only then can say the script wrote
   * nowhere the parent looked.
   */
  outputJson: string;
  /** `$ARGENT_REASON`: the failure text, read only on a non-zero exit. */
  reasonFile: string;
}

export type ScriptExecuteRequest = ScriptExecuteNodeRequest | ScriptExecuteBashRequest;

export type ScriptFailureType =
  | "load"
  | "runtime"
  | "output"
  | "exit"
  | "protocol"
  | "spawn"
  | "signal";

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
 * The two the runner can only reach in bash mode, where it spawns its own child
 * and so is the side that learns bash could not be started or was killed by a
 * signal. Refused in node mode, where the parent reaches both conclusions
 * itself: there the script runs INSIDE the runner with the protocol descriptor
 * open, and `spawn` is a kind the step reports as "nothing ran, so there is
 * nothing to clean up" — an answer a script that has already done its work must
 * not be able to write for itself. Bash cannot: the runner hands its own child
 * a null device in that slot.
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

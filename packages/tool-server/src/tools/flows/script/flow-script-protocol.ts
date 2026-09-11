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
  interpreterPath: string;
  scriptPath: string;
  outputFile: string;
  outputJson: string;
  /**
   * The parent's OWN time limit - {@link ScriptExecuteCommon.deadlineMs} minus
   * the stall margin the child's watchdog sits behind it. The runner needs it
   * because it has one wait of its own: when bash dies by a signal it holds the
   * answer briefly, in case the same signal is still on its way to the group.
   * Bounded by nothing, that wait outlived the parent's timer on a short step,
   * and a signalled bash was reported as a time limit that was never exceeded.
   */
  timeoutMs: number;
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

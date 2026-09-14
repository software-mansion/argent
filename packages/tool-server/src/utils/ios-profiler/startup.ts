import type { ChildProcess } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { NotifyHandle } from "./notify";

interface WaitForXctraceReadyOptions {
  notify: NotifyHandle | null;
  timeoutMs: number;
}

interface WaitForXctraceReadyResult {
  /** stderr accumulated while waiting for ready. */
  stderrBuffer: string;
}

/**
 * Wait for `xctrace record` to reach the recording state, signalled by whichever
 * comes first: the Darwin notification or a stdout substring match. Rejects on
 * early child exit, spawn error, or startup timeout; the timeout SIGKILLs the
 * child so it cannot leak.
 *
 * Listeners stay attached for the lifetime of the child: without an `'error'`
 * listener, the async error Node emits when a `kill()` syscall fails would crash
 * the process. They are no-ops after settle, so the caller may attach its own.
 */
export function waitForXctraceReady(
  child: ChildProcess,
  { notify, timeoutMs }: WaitForXctraceReadyOptions
): Promise<WaitForXctraceReadyResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderrBuffer = "";

    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (notify) notify.cancel();
      run();
    };

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Ctrl-C to stop") || text.includes("Starting recording")) {
        settle(() => resolve({ stderrBuffer }));
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    child.on("exit", (code, signal) => {
      settle(() =>
        reject(
          new FailureError(
            `xctrace record exited before recording started (code=${code}, signal=${signal}). ` +
              `stderr: ${stderrBuffer.trim() || "<empty>"}`,
            {
              error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED,
              failure_stage: "native_profiler_xctrace_ready",
              failure_area: "tool_server",
              error_kind: "subprocess",
              failure_command: "xctrace",
              ...(typeof code === "number" ? { failure_exit_code: code } : {}),
              ...(signal === "SIGABRT" ||
              signal === "SIGHUP" ||
              signal === "SIGINT" ||
              signal === "SIGKILL" ||
              signal === "SIGQUIT" ||
              signal === "SIGTERM"
                ? { failure_signal: signal }
                : {}),
            }
          )
        )
      );
    });

    child.on("error", (err: Error) => {
      settle(() =>
        reject(
          new FailureError(
            `Failed to start xctrace: ${err.message}`,
            {
              error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_PROCESS_ERROR,
              failure_stage: "native_profiler_xctrace_process",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata(err, "xctrace"),
            },
            { cause: err }
          )
        )
      );
    });

    const startupTimer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
        reject(
          new FailureError(
            `xctrace record did not start within ${timeoutMs} ms. ` +
              `Last stderr: ${stderrBuffer.trim() || "<empty>"}`,
            {
              error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_TIMEOUT,
              failure_stage: "native_profiler_xctrace_ready",
              failure_area: "tool_server",
              error_kind: "timeout",
              failure_command: "xctrace",
              failure_signal: "SIGKILL",
            }
          )
        );
      });
    }, timeoutMs);

    if (notify) {
      notify.fired
        .then(() => settle(() => resolve({ stderrBuffer })))
        .catch(() => {
          /* ignore */
        });
    }
  });
}

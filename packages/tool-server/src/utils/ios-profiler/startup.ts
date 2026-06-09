import type { ChildProcess } from "child_process";
import type { NotifyHandle } from "./notify";

export interface WaitForXctraceReadyOptions {
  notify: NotifyHandle | null;
  timeoutMs: number;
}

export interface WaitForXctraceReadyResult {
  /** stderr accumulated during startup; empty once we reach ready. */
  stderrBuffer: string;
}

/**
 * Wait for `xctrace record` to reach the recording state. Resolves on either
 * the Darwin notification (preferred) or the localised stdout substring
 * fallback. Rejects on early child exit, spawn error, or startup timeout —
 * and on timeout sends SIGKILL so the child cannot leak.
 *
 * Listeners installed here stay attached for the lifetime of the child: late
 * events (notably the async `'error'` Node emits if a `kill()` syscall fails)
 * would crash the process if there were no `'error'` listener at all. They
 * become no-ops after settle because (a) `settle()` short-circuits and (b)
 * `resolve()` / `reject()` on an already-settled promise is a no-op. The
 * caller is free to attach its own post-ready listeners alongside.
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
          new Error(
            `xctrace record exited before recording started (code=${code}, signal=${signal}). ` +
              `stderr: ${stderrBuffer.trim() || "<empty>"}`
          )
        )
      );
    });

    child.on("error", (err: Error) => {
      settle(() => reject(new Error(`Failed to start xctrace: ${err.message}`)));
    });

    const startupTimer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        reject(
          new Error(
            `xctrace record did not start within ${timeoutMs} ms. ` +
              `Last stderr: ${stderrBuffer.trim() || "<empty>"}`
          )
        );
      });
    }, timeoutMs);

    if (notify) {
      notify.fired
        .then(() => settle(() => resolve({ stderrBuffer })))
        .catch(() => {
          // notify failures fall through to stdout substring match
        });
    }
  });
}

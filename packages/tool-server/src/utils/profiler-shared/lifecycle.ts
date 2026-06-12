import type { ChildProcess } from "child_process";

export interface ShutdownTimings {
  /** SIGINT → exit window. */
  graceMs: number;
  /** SIGTERM → exit window if SIGINT was ignored. */
  termMs: number;
  /** SIGKILL → exit window if SIGTERM was ignored. */
  killMs: number;
}

export interface ShutdownResult {
  /** True if SIGINT alone was enough to bring the child down. */
  clean: boolean;
  /** The signal that ultimately produced the exit (or was last attempted). */
  signalUsed: "SIGINT" | "SIGTERM" | "SIGKILL";
}

/**
 * Resolves true if the child has already exited or exits within `ms`.
 * Resolves false on timeout. Driven by the `'exit'` event (delivered straight
 * from `waitpid()`), not by polling — no PID-reuse hazard.
 */
export function waitForChildExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

/**
 * Bring the child down via the SIGINT → SIGTERM → SIGKILL ladder. Each
 * `child.kill(...)` is sent through the handle, so a kernel-reused PID can
 * never be the recipient. Returns whether SIGINT alone was sufficient.
 */
export async function shutdownChild(
  child: ChildProcess,
  t: ShutdownTimings
): Promise<ShutdownResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { clean: true, signalUsed: "SIGINT" };
  }

  try {
    child.kill("SIGINT");
  } catch {
    // already dead
  }
  if (await waitForChildExit(child, t.graceMs)) {
    return { clean: true, signalUsed: "SIGINT" };
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }
  if (await waitForChildExit(child, t.termMs)) {
    return { clean: false, signalUsed: "SIGTERM" };
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // already dead
  }
  await waitForChildExit(child, t.killMs);
  return { clean: false, signalUsed: "SIGKILL" };
}

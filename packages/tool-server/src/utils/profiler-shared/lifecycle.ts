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
  /** No escalation past SIGINT was needed. */
  clean: boolean;
  /** Furthest signal the ladder reached. */
  signalUsed: "SIGINT" | "SIGTERM" | "SIGKILL";
}

/**
 * Resolves true if the child has exited within `ms`, false on timeout.
 * Event-driven rather than PID polling, so a reused PID cannot fool it.
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
 * SIGINT → SIGTERM → SIGKILL ladder. Signals go through the child handle, so a
 * kernel-reused PID can never be the recipient.
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
    /* best-effort */
  }
  if (await waitForChildExit(child, t.graceMs)) {
    return { clean: true, signalUsed: "SIGINT" };
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* best-effort */
  }
  if (await waitForChildExit(child, t.termMs)) {
    return { clean: false, signalUsed: "SIGTERM" };
  }

  try {
    child.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
  await waitForChildExit(child, t.killMs);
  return { clean: false, signalUsed: "SIGKILL" };
}

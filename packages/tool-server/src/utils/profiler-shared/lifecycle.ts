import type { ChildProcess } from "child_process";

interface ShutdownTimings {
  /** SIGINT → exit window. */
  graceMs: number;
  /** SIGTERM → exit window if SIGINT was ignored. */
  termMs: number;
  /** SIGKILL → exit window if SIGTERM was ignored. */
  killMs: number;
  /**
   * Ends the SIGINT window early when the child makes no progress: `probe`
   * returns a fingerprint of its progress (CPU time, bytes written), or null
   * when it cannot tell, and the same fingerprint for `idleMs` means it hangs.
   */
  stall?: { probe: () => Promise<string | null>; idleMs: number; pollMs: number };
}

interface ShutdownResult {
  /** No escalation past SIGINT was needed. */
  clean: boolean;
  /** Furthest signal the ladder reached. */
  signalUsed: "SIGINT" | "SIGTERM" | "SIGKILL";
  /** The SIGINT window ended early because the child made no progress. */
  stalled?: true;
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
  const exited = t.stall
    ? await waitForExitOrStall(child, t.graceMs, t.stall)
    : (await waitForChildExit(child, t.graceMs)) && "exited";
  if (exited === "exited") {
    return { clean: true, signalUsed: "SIGINT" };
  }
  const stalled = exited === "stalled" ? { stalled: true as const } : {};

  try {
    child.kill("SIGTERM");
  } catch {
    /* best-effort */
  }
  if (await waitForChildExit(child, t.termMs)) {
    return { clean: false, signalUsed: "SIGTERM", ...stalled };
  }

  try {
    child.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
  await waitForChildExit(child, t.killMs);
  return { clean: false, signalUsed: "SIGKILL", ...stalled };
}

async function waitForExitOrStall(
  child: ChildProcess,
  graceMs: number,
  stall: NonNullable<ShutdownTimings["stall"]>
): Promise<"exited" | "stalled" | false> {
  const deadline = Date.now() + graceMs;
  let last: string | null = null;
  let sameSince = Date.now();
  while (Date.now() < deadline) {
    if (await waitForChildExit(child, Math.min(stall.pollMs, deadline - Date.now()))) {
      return "exited";
    }
    const now = await stall.probe().catch(() => null);
    if (now === null || now !== last) {
      last = now;
      sameSince = Date.now();
    } else if (Date.now() - sameSince >= stall.idleMs) {
      return "stalled";
    }
  }
  return false;
}

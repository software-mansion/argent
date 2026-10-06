import { execFileSync, spawn } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// Generous enough that the FIRST run on a fresh machine still resolves — macOS
// Gatekeeper assessment of the freshly written binary adds a one-time delay, and
// timing out there means random fallback ids for this process's events until an
// async upgrade migrates. The cap only exists to bound a wedged binary.
const FINGERPRINT_TIMEOUT_MS = 5_000;

// A fingerprint is 64 bytes; 4 KiB bounds a binary that streams output instead
// of Node's 1 MiB execFileSync default.
const FINGERPRINT_MAX_BUFFER = 4096;

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`,
 * SYNCHRONOUSLY.
 *
 * Blocks the event loop, so it is used only where blocking pays: the first
 * tracked event of a fresh machine (nothing persisted yet), so that event
 * already carries the stable id rather than a random fallback that later
 * migrates. Every other resolution uses the async variant below. Best-effort:
 * returns null, never throws.
 *
 * Hard-bounded with SIGKILL as `killSignal`: blocking the loop leaves no room
 * for a JS-side watchdog, and execFileSync's `timeout` sends `killSignal`
 * exactly once without escalating — the default SIGTERM can be trapped.
 */
export function resolveHostFingerprint(): string | null {
  try {
    const out = execFileSync(simulatorServerBinaryPath(), ["fingerprint"], {
      encoding: "utf8",
      timeout: FINGERPRINT_TIMEOUT_MS,
      // SIGKILL, not the default SIGTERM: a binary that ignores SIGTERM would
      // otherwise block the (synchronous) event loop past the cap forever.
      killSignal: "SIGKILL",
      maxBuffer: FINGERPRINT_MAX_BUFFER,
      // Ignore stderr so the binary's diagnostics don't pollute the caller's.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`,
 * ASYNCHRONOUSLY.
 *
 * Used for every resolution except the truly-fresh first event: the background
 * upgrade from a fallback id, the recovery re-probe after a transient failure,
 * and the tool-server's startup warm-up.
 *
 * Two lifecycle guarantees make it safe for both long- and short-lived callers:
 *  - It ALWAYS settles. spawn's own timeout only *sends* SIGTERM once and never
 *    escalates, so a child that ignores SIGTERM would leave the promise pending
 *    forever — wedging the tool-server, which gates readiness on it. An
 *    independent watchdog SIGKILLs the child at the cap and resolves null.
 *  - It never holds a short-lived process open at exit. The child AND its stdout
 *    pipe are unref'd (unref on the ChildProcess alone leaves the piped stdout
 *    handle keeping the loop alive), so a CLI exits with the probe abandoned. A
 *    long-lived process still receives the result.
 *
 * Best-effort: resolves to null, never rejects.
 */
export function resolveHostFingerprintAsync(): Promise<string | null> {
  return new Promise((resolve) => {
    let binary: string;
    try {
      binary = simulatorServerBinaryPath();
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      // Reap on every settle path: a no-op if the child already exited (ESRCH is
      // swallowed); on the watchdog path this SIGKILLs a SIGTERM-ignoring binary.
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    // Independent watchdog: spawn's timeout only SENDS SIGTERM once and never
    // escalates to SIGKILL, so bound the spawn ourselves. Created before spawn so
    // `finish` can always clear it. Unref'd so it never keeps a short-lived process
    // alive; a long-lived caller's loop stays alive on its own work, so it still fires.
    const watchdog = setTimeout(() => finish(null), FINGERPRINT_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      child = spawn(binary, ["fingerprint"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }

    let out = "";
    let overflowed = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (overflowed) return;
      out += chunk;
      if (out.length > FINGERPRINT_MAX_BUFFER) {
        overflowed = true;
        finish(null); // SIGKILLs the runaway child via finish()
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (overflowed) return;
      const trimmed = out.trim();
      finish(code === 0 && trimmed.length > 0 ? trimmed : null);
    });

    // Unref the child AND its stdout pipe so a best-effort background probe never
    // holds a short-lived process open at exit. (A piped stdout is a Socket with
    // unref at runtime, though typed as a plain Readable.)
    child.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
  });
}

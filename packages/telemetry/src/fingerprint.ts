import { execFileSync, spawn } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// `simulator-server fingerprint` just reads host hardware ids and is fast once
// warm (<100ms). The cap must be generous enough that the FIRST run on a fresh
// machine still resolves — e.g. the binary's first execution right after
// `argent install`, where macOS Gatekeeper assessment of the freshly written
// binary can add a one-time delay. Timing out there would fall back to a random
// id for that process's events (until an async upgrade migrates), so we err
// toward resolving; the cap only exists to bound a genuinely wedged binary.
const FINGERPRINT_TIMEOUT_MS = 5_000;

// Cap captured stdout so a wedged binary that streams output is bounded to a
// small cap rather than Node's 1 MiB execFileSync default. A fingerprint is 64
// bytes; 4 KiB is generous.
const FINGERPRINT_MAX_BUFFER = 4096;

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`,
 * SYNCHRONOUSLY.
 *
 * Blocks the event loop for the spawn, so it is used only on the ONE path where
 * blocking is worth it: the very first tracked event of a truly-fresh machine
 * (no id persisted yet), so that first event already carries the stable id
 * rather than a random fallback that later migrates. Every other resolution —
 * upgrading a fallback id, re-probing after a transient failure, the
 * tool-server's off-the-accept-path warm-up — uses the async variant below so
 * it never stalls the loop. Best-effort: returns null (never throws) when the
 * binary is absent or the command fails.
 *
 * HARD-bounded so the synchronous call always returns: because this blocks the
 * event loop, a child that outlives the cap would freeze the whole command with
 * no chance for a JS-side watchdog to run. execFileSync's `timeout` sends
 * `killSignal` exactly once and never escalates, and the default SIGTERM can be
 * trapped/ignored — so we pass SIGKILL (untrappable) as the kill signal. That is
 * the sync-path equivalent of the async variant's watchdog + SIGKILL: a wedged or
 * SIGTERM-ignoring binary is reaped at the cap and this returns null instead of
 * blocking indefinitely.
 */
export function resolveHostFingerprint(): string | null {
  try {
    const out = execFileSync(simulatorServerBinaryPath(), ["fingerprint"], {
      encoding: "utf8",
      timeout: FINGERPRINT_TIMEOUT_MS,
      // Reap with SIGKILL, not the default SIGTERM: a binary that ignores SIGTERM
      // would otherwise block the (synchronous) event loop past the cap forever.
      // SIGKILL can't be trapped, so the timeout is a genuine bound here.
      killSignal: "SIGKILL",
      // Cap captured stdout (same limit as the async variant): a binary streaming
      // output is SIGKILL'd at this cap rather than filling Node's 1 MiB default.
      maxBuffer: FINGERPRINT_MAX_BUFFER,
      // Ignore stderr so a binary that logs diagnostics doesn't pollute the
      // caller's stderr; stdout (index 1) is captured as the return value.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`,
 * ASYNCHRONOUSLY — the non-blocking form.
 *
 * Spawns off the event loop, so it never stalls request processing (notably the
 * tool-server's accept backlog) or a long-lived process's other work. Used for
 * every resolution except the truly-fresh first event: the background upgrade
 * from a fallback id to the fingerprint, the recovery re-probe after a transient
 * failure, and the tool-server's startup warm-up.
 *
 * Two lifecycle guarantees make it safe for both long- and short-lived callers:
 *  - It ALWAYS settles. `spawn`/`execFile`'s own timeout only *sends* SIGTERM
 *    once and never escalates, so a child that ignores SIGTERM would leave the
 *    promise pending forever — which, since the tool-server gates readiness on
 *    this promise, would wedge startup. An independent watchdog SIGKILLs the
 *    child at the cap and resolves null, so the promise is bounded regardless.
 *  - It never holds a short-lived process open at exit. The child AND its stdout
 *    pipe are unref'd (unref on the ChildProcess alone leaves the piped stdout
 *    handle keeping the loop alive), so a best-effort background probe is
 *    abandoned when a CLI finishes rather than delaying its exit. A long-lived
 *    process (its loop kept alive by its own work) still receives the result.
 *
 * Best-effort: resolves to null (never rejects) when the binary is absent, the
 * command fails, times out, or emits nothing.
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
      // Reap the child on every settle path. A no-op if it already exited
      // (ESRCH is swallowed); on the watchdog path this SIGKILLs a binary that
      // ignored the spawn timeout's SIGTERM.
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    // Independent watchdog: spawn's timeout (like execFile's) only SENDS SIGTERM
    // once and never escalates to SIGKILL, so bound the spawn ourselves. Created
    // before spawn so `finish` (which clears it) is always safe. Unref'd so it
    // never keeps a short-lived process alive; a long-lived caller's loop stays
    // alive on its own work, so it still fires there.
    const watchdog = setTimeout(() => finish(null), FINGERPRINT_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      child = spawn(binary, ["fingerprint"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // A synchronous throw from spawn (e.g. bad options) — treat as failure.
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

    // A best-effort background probe must not hold a short-lived process at exit:
    // unref the child AND its stdout pipe so the event loop can drain. (A piped
    // stdout is a Socket with unref at runtime, though typed as a plain Readable.)
    child.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
  });
}

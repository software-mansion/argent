import { spawn } from "node:child_process";
import { signalGroup } from "./process-kill";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";

/** `xcrun simctl` did not answer within its deadline; its process group was killed. */
export class SimctlTimeoutError extends Error {
  constructor(args: readonly string[], timeoutMs: number) {
    super(`xcrun ${args.join(" ")} did not answer within ${timeoutMs} ms`);
    this.name = "SimctlTimeoutError";
  }
}

/**
 * Run `xcrun <args>` and resolve with its stdout, killing the whole process
 * group when it overruns `timeoutMs` or `signal` aborts.
 *
 * Since Xcode 27.1 `simctl` is a bash wrapper that runs
 * `xcodebuild -runFirstLaunch` before exec'ing the real binary whenever the
 * installed CoreSimulator is older than it expects. Unattended, that never
 * returns, and SIGKILL on the direct child (what `execFile`'s `timeout` does)
 * leaves the `xcodebuild` behind as an orphan. Spawning detached makes the
 * child lead its own group, so `kill(-pid)` reaps the wrapper's descendants
 * too. `execFile` drops `detached`, hence the hand-rolled spawn.
 *
 * The flip side: the call leaves the caller's own group, so a caller that is
 * SIGKILLed mid-call (no chance to abort) no longer takes it along. Abort
 * through `signal` on every orderly exit.
 */
export function execSimctl(
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? SIMCTL_SPAWN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`xcrun ${args.join(" ")} aborted`));
      return;
    }
    const child = spawn("xcrun", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(stdout);
    };
    const killGroup = (): void => {
      if (child.pid) signalGroup(child.pid, "SIGKILL");
    };
    const onAbort = (): void => {
      killGroup();
      settle(new Error(`xcrun ${args.join(" ")} aborted`));
    };

    const timer = setTimeout(() => {
      killGroup();
      settle(new SimctlTimeoutError(args, timeoutMs));
    }, timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => settle(err));
    child.on("close", (code, sig) => {
      if (code === 0) return settle(null);
      settle(
        new Error(
          `xcrun ${args.join(" ")} exited with ${sig ?? `code ${code}`}` +
            (stderr.trim() ? `: ${stderr.trim()}` : "")
        )
      );
    });
  });
}

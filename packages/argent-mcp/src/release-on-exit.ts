import { raiseSignal } from "@argent/tools-client";

const EXIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Runs `release` when the editor ends stdin or stops the process with a
 * signal. A signal ends the process once the release settles.
 */
export function releaseOnExit(release: () => Promise<unknown>): void {
  // The stdio transport does not close when the editor ends stdin.
  process.stdin.on("close", () => void release());

  function releaseThenRaise(signal: NodeJS.Signals): void {
    void release().finally(() => {
      for (const s of EXIT_SIGNALS) process.removeListener(s, releaseThenRaise);
      raiseSignal(signal);
    });
  }
  for (const signal of EXIT_SIGNALS) process.on(signal, releaseThenRaise);
}

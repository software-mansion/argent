// Process-level handlers for uncaughtException and unhandledRejection.
//
// In MCP-server mode we do NOT exit on every uncaught error — many are
// transient and the editor expects the server to keep running. But the naive
// version (`stderr.write(...); if (!isMcp) exit`) burns 100% CPU when stderr
// itself is broken (e.g. the parent process is gone): the write emits an
// async 'error' event on the stream, which without a listener becomes another
// uncaughtException, runs the handler, writes to the same broken stream, ...
//
// The fix has three pieces:
//   1. `'error'` listeners on stdout/stderr — broken stdio is fatal; exit
//      before the failure round-trips into uncaughtException. This is what
//      breaks the production loop.
//   2. try/catch around `stderr.write` — synchronous write failures also exit
//      cleanly instead of escaping into another uncaughtException.
//   3. try/catch around the formatter — a throwing `.stack` getter or
//      `toString` (the production trace pointed at defaultPrepareStackTrace)
//      can't take down the handler.

let installed = false;

export function installFatalHandlers(opts: { isMcpServer: boolean }): void {
  if (installed) return;
  installed = true;

  for (const stream of [process.stdout, process.stderr] as const) {
    stream.on("error", () => process.exit(1));
  }

  function reportFatal(label: string, getDetail: () => string): void {
    try {
      let detail: string;
      try {
        detail = getDetail();
      } catch {
        detail = "<failed to format>";
      }
      process.stderr.write(`[argent] ${label}: ${detail}\n`);
    } catch {
      process.exit(1);
    }
    if (!opts.isMcpServer) process.exit(1);
  }

  process.on("uncaughtException", (err) => {
    reportFatal("Uncaught exception", () => String((err as Error)?.stack ?? err));
  });
  process.on("unhandledRejection", (reason) => {
    reportFatal("Unhandled rejection", () =>
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    );
  });
}

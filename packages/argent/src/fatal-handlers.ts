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
//
// When stdio is unusable we cannot tell the parent process what went wrong,
// so we leave a breadcrumb on disk at `~/.argent/mcp-fatal.log`. Sibling of
// the other persistent argent diagnostic logs (`tool-server.log`, etc.).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let installed = false;

const FATAL_LOG_PATH = path.join(os.homedir(), ".argent", "mcp-fatal.log");

function appendFatalLog(label: string, detail: string): void {
  try {
    fs.mkdirSync(path.dirname(FATAL_LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] pid=${process.pid} ${label}: ${detail}\n`;
    fs.appendFileSync(FATAL_LOG_PATH, line);
  } catch {
    // Last-resort log — if even this write fails (read-only fs, missing home),
    // there is nothing more we can do. Swallow so we still exit cleanly.
  }
}

export function installFatalHandlers(opts: { isMcpServer: boolean }): void {
  if (installed) return;
  installed = true;

  for (const stream of [process.stdout, process.stderr] as const) {
    const name = stream === process.stdout ? "stdout" : "stderr";
    stream.on("error", (err) => {
      appendFatalLog(`Broken ${name}`, String((err as Error)?.stack ?? err));
      process.exit(1);
    });
  }

  function reportFatal(label: string, getDetail: () => string): void {
    let detail: string;
    try {
      detail = getDetail();
    } catch {
      detail = "<failed to format>";
    }
    try {
      process.stderr.write(`[argent] ${label}: ${detail}\n`);
    } catch {
      // Synchronous stderr write failed — stderr is unusable but the 'error'
      // listener above may not fire synchronously, so persist the breadcrumb
      // here too before we exit.
      appendFatalLog(label, detail);
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

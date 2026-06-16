import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tool-server side of the Electron preview window. A single Electron child
 * is spawned on demand when `await_user_selection` parks and quits (with an
 * animated squeeze) when the user submits — same window is reused across
 * multiple await cycles within one tool-server lifetime.
 *
 * No ports: communication with the child is line-delimited JSON over stdin.
 * The child loads the tool-server's HTTP `/preview/` URL directly; the
 * tool-server's port is already ephemeral in production
 * (`argent-tools-client/src/launcher.ts` uses `findFreePort`).
 */
export interface PreviewWindowManager {
  /** Spawn the window if not running; foreground + (re)load otherwise. */
  ensureOpen(url: string): void;
  /** Ask the window to play the close animation and exit. */
  requestClose(): void;
  /** Hard kill any live child; safe to call multiple times. */
  dispose(): void;
}

export interface PreviewWindowManagerOptions {
  /** Override for tests / unusual installs (default: `require("electron")`). */
  electronBinaryPath?: string;
  /** Override for tests (default: `@argent/preview-window/dist/main.js`). */
  mainScript?: string;
  /** Optional error sink — defaults to stderr. */
  onError?: (err: Error) => void;
  /**
   * Called specifically when the window FAILS TO LAUNCH — either the
   * synchronous electron/main-script resolve throws (the common
   * electron-absent case, since `electron` is an optionalDependency) or the
   * spawned child emits `error` (ENOENT / EACCES). NOT called for failures
   * after the window is already up. Lets callers fail fast with actionable
   * guidance instead of leaving a parked `await_user_selection` to time out.
   */
  onLaunchFailure?: (err: Error) => void;
}

export function createPreviewWindowManager(
  opts: PreviewWindowManagerOptions = {}
): PreviewWindowManager {
  let child: ChildProcess | null = null;

  const reportError = (err: Error): void => {
    if (opts.onError) opts.onError(err);
    else process.stderr.write(`[preview-window] ${err.message}\n`);
  };

  const send = (msg: { cmd: string; [k: string]: unknown }): void => {
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const resolveElectronBin = (): string => {
    if (opts.electronBinaryPath) return opts.electronBinaryPath;
    // `require("electron")` from outside an Electron context returns the
    // path string to the Electron executable shipped in node_modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron") as string;
  };

  const resolveMainScript = (): string => {
    if (opts.mainScript) return opts.mainScript;
    // Two layouts to support:
    //   1) Published @swmansion/argent bundle. The bundler drops the
    //      preview-window's compiled main next to the tool-server bundle
    //      at <install>/dist/preview-window/main.cjs. The workspace pkg
    //      `@argent/preview-window` isn't a sibling install at that
    //      point, so require.resolve would fail.
    //   2) Workspace dev (ts-node from packages/tool-server/src). The
    //      sibling package IS resolvable; fall through to that.
    const bundled = path.join(__dirname, "preview-window", "main.cjs");
    if (fs.existsSync(bundled)) return bundled;
    return require.resolve("@argent/preview-window/dist/main.js");
  };

  const isAlive = (c: ChildProcess | null): c is ChildProcess =>
    c !== null && c.exitCode === null && !c.killed;

  const ensureOpen = (url: string): void => {
    if (isAlive(child)) {
      send({ cmd: "foreground", url });
      return;
    }
    let electronBin: string;
    let mainScript: string;
    try {
      electronBin = resolveElectronBin();
      mainScript = resolveMainScript();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e);
      opts.onLaunchFailure?.(e);
      return;
    }
    const next = spawn(electronBin, [mainScript], {
      env: { ...process.env, ARGENT_PREVIEW_URL: url },
      stdio: ["pipe", "ignore", "pipe"],
    });
    // `spawn` does not throw synchronously for ENOENT / EACCES — the error
    // arrives asynchronously. Clear `child` here too so a follow-up
    // `ensureOpen` retries cleanly instead of no-oping against a dead handle
    // that hasn't yet emitted `exit`.
    next.on("error", (err) => {
      if (child === next) child = null;
      reportError(err);
      opts.onLaunchFailure?.(err);
    });
    next.on("exit", () => {
      if (child === next) child = null;
    });
    next.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[preview-window] ${chunk}`);
    });
    child = next;
  };

  const requestClose = (): void => {
    if (!isAlive(child)) return;
    send({ cmd: "close" });
  };

  const dispose = (): void => {
    if (isAlive(child)) child.kill();
    child = null;
  };

  return { ensureOpen, requestClose, dispose };
}

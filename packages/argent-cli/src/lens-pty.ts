/**
 * Terminal-agnostic agent takeover for `argent lens`: the agent runs inside a
 * PTY this process proxies, and Lens feedback is written on the SAME channel as
 * the user's keystrokes, so the agent can't tell it from typing.
 *
 * The AppleScript path (`lens-terminal.ts`) needs the terminal app's own
 * scripting (`write text` / `do script`) because macOS locks down TIOCSTI, so it
 * only works in iTerm/Terminal — not Warp / VS Code / tmux. The cost here is that
 * `argent lens` forwards stdin/stdout and tracks window-resize for one child,
 * like `tmux`/`ssh` do.
 *
 * `node-pty` is a native OPTIONAL dependency of @swmansion/argent, loaded lazily
 * via `loadNodePty()` so an absent or broken install degrades to the AppleScript
 * new-window fallback instead of crashing.
 */

import { chmodSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { flattenLine } from "./lens-terminal.js";

// Named `nodeRequire` (not `require`) so esbuild doesn't treat it as a bundling
// require and it can't collide with the ESM bundle's `createRequire` banner.
const nodeRequire = createRequire(import.meta.url);

// Only what we use, so the `tsc` build needs no node-pty types: the dependency
// lives on the published @swmansion/argent, not on @argent/cli.

interface IDisposable {
  dispose(): void;
}

export interface IPty {
  readonly pid: number;
  onData(cb: (data: string) => void): IDisposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePty {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  ): IPty;
}

/**
 * node-pty's macOS prebuilds ship `spawn-helper` WITHOUT the executable bit, so
 * the first pty.spawn() fails with "posix_spawnp failed". Best-effort: any
 * failure leaves the AppleScript new-window fallback intact. Runs at load time
 * rather than in an npm postinstall, so installs that skip install scripts
 * (pnpm's build gate, --ignore-scripts, Yarn PnP) still get a working PTY.
 */
export function ensureSpawnHelperExecutable(req: NodeRequire = nodeRequire): void {
  if (process.platform !== "darwin") return;
  try {
    const prebuilds = join(dirname(req.resolve("node-pty/package.json")), "prebuilds");
    for (const entry of readdirSync(prebuilds)) {
      try {
        chmodSync(join(prebuilds, entry, "spawn-helper"), 0o755);
      } catch {
        /* no helper for this arch */
      }
    }
  } catch {
    /* node-pty missing or layout changed — lens falls back */
  }
}

/**
 * Null when node-pty isn't installed / fails to load, so the caller can fall back
 * to the AppleScript new-window path. The `req` seam keeps this testable without
 * the native addon.
 */
export function loadNodePty(req: NodeRequire = nodeRequire): NodePty | null {
  try {
    const mod = req("node-pty") as NodePty;
    if (!mod || typeof mod.spawn !== "function") return null;
    ensureSpawnHelperExecutable(req);
    return mod;
  } catch {
    return null;
  }
}

// Minimal stream surfaces, so tests can pass fakes.

export interface ProxyInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  off(event: "data", listener: (data: Buffer) => void): void;
}

export interface ProxyOutput {
  columns?: number;
  rows?: number;
  write(chunk: string): void;
}

/** A live agent running under a PTY this process proxies. */
export interface PtyProxy {
  /** PID of the `/bin/sh` wrapping the agent, not of the agent itself. */
  readonly pid: number;
  /**
   * Inject one line as if typed: Esc (interrupt an in-flight turn / clear the
   * composer), the flattened text, then a separate Enter to submit. Waits for a
   * pause in the user's own typing first, and serializes concurrent rounds.
   * False once disposed.
   */
  inject(text: string): boolean;
  /** Raw bytes to the agent, no Esc/Enter framing — e.g. a lone Enter to confirm
   * a first-run prompt. False once disposed. */
  write(data: string): boolean;
  /** Observe the agent's output in addition to the screen — used to watch for a
   * first-run "trust this folder?" prompt. */
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  /** Synchronously restore the terminal (raw mode off, listeners removed) and
   * kill the agent. Idempotent; safe from a signal handler before exit. */
  dispose(): void;
}

export interface InjectBeat {
  delayBeforeMs: number;
  data: string;
}

// Beat spacing lets a TUI composer register each write before the next lands
// (mirrors the AppleScript path's 0.15s / 0.2s delays).
const ESC = "\x1b";
const ENTER = "\r";
const BEAT_AFTER_ESC_MS = 150;
const BEAT_AFTER_TEXT_MS = 200;

// Feedback arrives unpredictably and its first beat is an Esc that clears the
// composer, so wait for a pause in the user's OWN input before injecting —
// capped so feedback is never delayed indefinitely. This only saves an
// in-progress keystroke burst, not a draft left sitting (indistinguishable from
// an idle composer).
const QUIET_BEFORE_INJECT_MS = 600;
const MAX_QUIET_WAIT_MS = 3_000;
const QUIET_POLL_MS = 100;

/**
 * The keystroke beats that queue one feedback line to the agent. Mirrors
 * `buildWriteScript`'s three beats: a leading Esc, the flattened text (no
 * embedded newline, so the composer doesn't submit early), then a standalone
 * Enter that submits.
 */
export function ptyInjectBeats(text: string): InjectBeat[] {
  return [
    { delayBeforeMs: 0, data: ESC },
    { delayBeforeMs: BEAT_AFTER_ESC_MS, data: flattenLine(text) },
    { delayBeforeMs: BEAT_AFTER_TEXT_MS, data: ENTER },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartPtyProxyOptions {
  /** From `loadNodePty()`. */
  pty: NodePty;
  /** The agent launch line, run via `/bin/sh -c` inside the PTY. */
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.stdin / process.stdout — overridable for tests. */
  stdin?: ProxyInput;
  stdout?: ProxyOutput;
  /** SIGWINCH source; defaults to `process` (test seam). */
  signals?: {
    on(event: "SIGWINCH", listener: () => void): void;
    off(event: "SIGWINCH", listener: () => void): void;
  };
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Spawn the agent under a PTY and wire `argent lens` as its terminal proxy:
 * raw-mode stdin → PTY, PTY output → stdout, window resize → PTY, plus the
 * `inject` channel the feedback relay uses.
 */
export function startPtyProxy(opts: StartPtyProxyOptions): PtyProxy {
  const stdin = opts.stdin ?? (process.stdin as unknown as ProxyInput);
  const stdout = opts.stdout ?? (process.stdout as unknown as ProxyOutput);
  const signals =
    opts.signals ?? (process as unknown as NonNullable<StartPtyProxyOptions["signals"]>);

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;

  const term = opts.pty.spawn("/bin/sh", ["-c", opts.command], {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });

  const observers: Array<(chunk: string) => void> = [];
  const exitCbs: Array<(code: number) => void> = [];

  // Observers are the trust-prompt watcher's window onto the agent's output.
  const dataSub = term.onData((d) => {
    stdout.write(d);
    for (const cb of observers) cb(d);
  });

  // Raw mode disables the host tty's line discipline so keystrokes (incl. Ctrl-C
  // as 0x03) reach the agent byte-for-byte. Each one stamps `lastUserInputAt` so
  // `inject` can wait for a typing pause before its composer-clearing Esc.
  const wasRaw = Boolean(stdin.isRaw);
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  let lastUserInputAt = 0;
  const onStdin = (d: Buffer): void => {
    lastUserInputAt = Date.now();
    term.write(d.toString("utf8"));
  };
  stdin.on("data", onStdin);

  const onResize = (): void => {
    if (stdout.columns && stdout.rows) term.resize(stdout.columns, stdout.rows);
  };
  signals.on("SIGWINCH", onResize);

  let disposed = false;
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      dataSub.dispose();
    } catch {
      /* already disposed */
    }
    stdin.off("data", onStdin);
    signals.off("SIGWINCH", onResize);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
    stdin.pause();
  };

  term.onExit(({ exitCode }) => {
    cleanup();
    for (const cb of exitCbs) cb(exitCode ?? 0);
  });

  // See the QUIET_* constants. No-op when the user hasn't typed at all
  // (`lastUserInputAt` still 0).
  const waitForTypingPause = async (): Promise<void> => {
    const started = Date.now();
    while (
      !disposed &&
      lastUserInputAt > 0 &&
      Date.now() - lastUserInputAt < QUIET_BEFORE_INJECT_MS &&
      Date.now() - started < MAX_QUIET_WAIT_MS
    ) {
      await sleep(QUIET_POLL_MS);
    }
  };

  // Serialize injects so two rapid rounds don't interleave their beats.
  let queue: Promise<void> = Promise.resolve();

  return {
    pid: term.pid,
    inject(text: string): boolean {
      if (disposed) return false;
      const beats = ptyInjectBeats(text);
      queue = queue
        .then(async () => {
          await waitForTypingPause();
          for (const beat of beats) {
            if (beat.delayBeforeMs) await sleep(beat.delayBeforeMs);
            if (disposed) return;
            term.write(beat.data);
          }
        })
        .catch(() => {
          /* a write after the agent vanished */
        });
      return true;
    },
    write(data: string): boolean {
      if (disposed) return false;
      try {
        term.write(data);
        return true;
      } catch {
        return false;
      }
    },
    onData(cb: (chunk: string) => void): void {
      observers.push(cb);
    },
    onExit(cb: (code: number) => void): void {
      exitCbs.push(cb);
    },
    dispose(): void {
      const wasDisposed = disposed;
      cleanup();
      if (!wasDisposed) {
        try {
          term.kill();
        } catch {
          /* already exited */
        }
      }
    },
  };
}

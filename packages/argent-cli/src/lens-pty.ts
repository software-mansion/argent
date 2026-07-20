/**
 * Terminal-agnostic agent takeover for `argent lens`, via a pseudo-terminal that
 * `argent lens` owns.
 *
 * The AppleScript path (`lens-terminal.ts`) can only take over and write into
 * iTerm/Terminal, because injecting a queued prompt into a running TUI needs the
 * terminal app's own scripting (`write text` / `do script`) — macOS locks down
 * TIOCSTI, and Warp / VS Code / tmux expose no such scripting. This module
 * sidesteps that entirely: it runs the agent inside a PTY that `argent lens`
 * controls and becomes a thin passthrough proxy in the middle —
 *
 *   you (real tty) ─stdin──► pty master ──► agent
 *   you (real tty) ◄─stdout─ pty master ◄── agent
 *   Lens feedback  ─────────► pty master ──► agent   (SAME channel as your keys)
 *
 * Because feedback travels the exact channel as your keystrokes, the agent can't
 * tell it from typing — so it works in ANY terminal (Warp included), not just the
 * scriptable ones. The cost is that `argent lens` now forwards stdin/stdout and
 * tracks window-resize for one child, exactly like `tmux`/`ssh` do.
 *
 * `node-pty` is a native module and an OPTIONAL dependency of @swmansion/argent
 * (like `electron`): it's loaded lazily via `loadNodePty()` so an absent or
 * broken install degrades to the AppleScript new-window fallback instead of
 * crashing. It's resolved through `createRequire` (not a static import) so the
 * esbuild publish bundle leaves it as a runtime require against the installed
 * package — there's nothing for esbuild to inline.
 */

import { chmodSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { flattenLine } from "./lens-terminal.js";

// Resolve node-pty at runtime from the installed package, not at bundle time.
// Named `nodeRequire` (not `require`) so esbuild doesn't treat it as a bundling
// require AND so it can't collide with the ESM bundle's `createRequire` banner.
const nodeRequire = createRequire(import.meta.url);

// ── Minimal node-pty surface ────────────────────────────────────────────────
// We declare just what we use so the `tsc` build needs no node-pty types (the
// dependency lives only on the published @swmansion/argent, not @argent/cli).

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
 * node-pty's macOS prebuilds ship `spawn-helper` WITHOUT the executable bit,
 * so the very first pty.spawn() fails with "posix_spawnp failed". Restore +x
 * on every prebuild's helper before use. Best-effort: any failure (req seam
 * without `resolve`, package layout change, read-only store) leaves the
 * AppleScript new-window fallback intact. This ran in the npm postinstall
 * before — it lives at load time so installs that never run install scripts
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
        /* no helper for this arch — ignore */
      }
    }
  } catch {
    /* node-pty missing or layout changed — lens falls back gracefully */
  }
}

/**
 * Load the native `node-pty` module, or null when it isn't installed / fails to
 * load (so the caller can fall back to the AppleScript new-window path). The
 * `req` seam keeps this unit-testable without the real native addon.
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

// ── Minimal stream surfaces (so tests can pass fakes) ───────────────────────

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
  /** node-pid of the agent's shell (diagnostics / tests). */
  readonly pid: number;
  /**
   * Inject one line into the agent as if typed: Esc (interrupt any in-flight
   * turn / clear the composer), the flattened text, then a separate Enter to
   * submit. First waits for a brief pause in the user's own typing so the
   * leading Esc doesn't clobber an in-progress keystroke burst. Beats are spaced
   * and serialized so concurrent rounds don't interleave. Returns false once the
   * proxy is disposed.
   */
  inject(text: string): boolean;
  /** Write raw bytes straight to the agent (no Esc/Enter framing) — e.g. a lone
   * Enter to confirm a first-run prompt. Returns false once disposed. */
  write(data: string): boolean;
  /** Observe the agent's output stream (in addition to the screen) — used to
   * watch for a first-run "trust this folder?" prompt. */
  onData(cb: (chunk: string) => void): void;
  /** Run `cb` when the agent exits (with its exit code). */
  onExit(cb: (code: number) => void): void;
  /** Synchronously restore the terminal (raw mode off, listeners removed) and
   * kill the agent. Idempotent; safe to call from a signal handler before exit. */
  dispose(): void;
}

export interface InjectBeat {
  /** Milliseconds to wait BEFORE writing `data` (0 for the first beat). */
  delayBeforeMs: number;
  data: string;
}

// Spacing between the Esc / text / Enter beats — lets a TUI composer register
// each before the next lands (mirrors the AppleScript path's 0.15s / 0.2s).
const ESC = "\x1b";
const ENTER = "\r";
const BEAT_AFTER_ESC_MS = 150;
const BEAT_AFTER_TEXT_MS = 200;

// Feedback is pushed (an SSE outcome can land at any instant), and the first
// beat is an Esc that clears the composer. Firing that mid-keystroke would wipe
// what the user is actively typing to the agent. So before injecting, wait for a
// brief pause in the user's OWN input — long enough to tell "still typing" from
// "stopped" — capped so feedback is never delayed indefinitely. This can't help
// a draft the user typed and then left sitting (that's fundamentally
// indistinguishable from an idle composer), but it stops the common case of
// interrupting an in-progress keystroke burst.
const QUIET_BEFORE_INJECT_MS = 600;
const MAX_QUIET_WAIT_MS = 3_000;
const QUIET_POLL_MS = 100;

/**
 * The keystroke beats that queue one feedback line to the agent. Pure +
 * exported for testing. Mirrors `buildWriteScript`'s three-beat sequence: a
 * leading Esc, the flattened text (no embedded newline, so the composer doesn't
 * submit early), then a standalone Enter that submits.
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
  /** The loaded node-pty module (from `loadNodePty`). */
  pty: NodePty;
  /** Shell command run in the PTY (the agent launch line). */
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.stdin / process.stdout — overridable for tests. */
  stdin?: ProxyInput;
  stdout?: ProxyOutput;
  /** SIGWINCH source; defaults to `process`. Overridable for tests. */
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
 * `inject` channel the feedback relay uses. Returns a handle; the agent runs
 * until it exits or `dispose()` is called.
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

  // PTY output → screen (and any observers, e.g. the trust-prompt watcher).
  const dataSub = term.onData((d) => {
    stdout.write(d);
    for (const cb of observers) cb(d);
  });

  // Real stdin → PTY, byte-for-byte. Raw mode disables the host tty's line
  // discipline so keystrokes (incl. Ctrl-C as 0x03) pass straight to the agent.
  // Each keystroke also stamps `lastUserInputAt` so `inject` can wait for a
  // typing pause before it fires its composer-clearing Esc.
  const wasRaw = Boolean(stdin.isRaw);
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  let lastUserInputAt = 0;
  const onStdin = (d: Buffer): void => {
    lastUserInputAt = Date.now();
    term.write(d.toString("utf8"));
  };
  stdin.on("data", onStdin);

  // Window resize → PTY, so the agent's TUI reflows correctly.
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

  // Hold off the inject until the user has paused typing (see the QUIET_*
  // constants), so the leading Esc doesn't clobber an in-progress keystroke
  // burst. No-op when the user hasn't typed at all (lastUserInputAt still 0).
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
          /* a write after the agent vanished — swallow */
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

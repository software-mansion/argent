import { spawn } from "child_process";
import * as readline from "readline";
import type { AppSuspensionWindow } from "./ios-profiler/app-suspensions";

/**
 * When macOS holds a Mac app suspended. Instruments suspends the whole app
 * while it checks it for leaks, about every 11 s and up to about 10 s each on
 * an app that argent drives, and a debugger or a stop signal suspends it too.
 * Nothing in the app runs then, argent's library included, so a call waits
 * until the app runs again.
 *
 * `argent-macos-helper watch-suspension --pid <pid>` reads the app's suspend
 * count from outside every 10 ms and prints `{"suspended":bool,"at":ms}` at
 * the start and at each change. Its windows matched the main-thread stalls of
 * a test program within 20 ms.
 */
export interface SuspensionWatch {
  readonly pid: number;
  /** Since when the app is suspended, or null while it runs or after the watch ended. */
  suspendedSince(): number | null;
  /** How many ms of [fromMs, toMs] the app was suspended. */
  suspendedMsBetween(fromMs: number, toMs: number): number;
  /** True once the app runs, at once when it runs; false when it is still suspended after `timeoutMs`. */
  waitUntilRunning(timeoutMs: number): Promise<boolean>;
  /** Stops the watch. The windows it saw, oldest first; one still open ends now. */
  end(): AppSuspensionWindow[];
}

/** How long the helper gets to report the app's first state. */
const FIRST_STATE_TIMEOUT_MS = 3_000;

/**
 * Starts the helper for `pid`. Null, with the reason on stderr, when the helper
 * cannot watch: one from before the command (it exits with "unknown command"),
 * or a process that is gone.
 */
export async function startSuspensionWatch(
  helperPath: string,
  pid: number
): Promise<SuspensionWatch | null> {
  const child = spawn(helperPath, ["watch-suspension", "--pid", String(pid)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const windows: AppSuspensionWindow[] = [];
  let since: number | null = null;
  let ended = false;
  let waiters: Array<() => void> = [];
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => {
    if (stderr.length < 2_000) stderr += d.toString("utf8");
  });

  const close = (atMs: number): void => {
    if (since !== null) windows.push({ startMs: since, endMs: Math.max(since, atMs) });
    since = null;
    const run = waiters;
    waiters = [];
    for (const wake of run) wake();
  };

  let reported!: (ok: boolean) => void;
  const firstState = new Promise<boolean>((resolve) => (reported = resolve));
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    let event: { suspended?: unknown; at?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event.suspended !== "boolean" || typeof event.at !== "number") return;
    reported(true);
    if (ended) return;
    if (event.suspended && since === null) since = event.at;
    else if (!event.suspended) close(event.at);
  });
  child.on("error", (err) => {
    stderr ||= err.message;
    reported(false);
  });
  // The app ended, or the helper was stopped: nothing is suspended any more.
  child.on("exit", () => {
    reported(false);
    if (!ended) close(Date.now());
    ended = true;
  });

  const timer = setTimeout(() => reported(false), FIRST_STATE_TIMEOUT_MS);
  const ok = await firstState;
  clearTimeout(timer);
  if (!ok || ended) {
    ended = true;
    child.kill();
    process.stderr.write(
      `[macos-app] argent cannot watch pid ${pid} for suspensions, so a call during a leak ` +
        `check can time out: ${stderr.trim() || "the helper reported nothing"}\n`
    );
    return null;
  }

  return {
    pid,
    suspendedSince: () => since,
    suspendedMsBetween(fromMs, toMs) {
      let total = 0;
      const open = since !== null ? [{ startMs: since, endMs: Date.now() }] : [];
      for (const w of [...windows, ...open]) {
        total += Math.max(0, Math.min(w.endMs, toMs) - Math.max(w.startMs, fromMs));
      }
      return total;
    },
    waitUntilRunning(timeoutMs) {
      if (since === null) return Promise.resolve(true);
      return new Promise((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== wake);
          resolve(since === null);
        }, timeoutMs);
        waiters.push(wake);
      });
    },
    end() {
      if (!ended) {
        ended = true;
        close(Date.now());
        child.kill();
      }
      return windows.map((w) => ({ ...w }));
    },
  };
}

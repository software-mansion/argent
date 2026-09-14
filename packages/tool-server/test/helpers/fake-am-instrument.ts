import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

/**
 * One `am instrument` run: what the device prints on each pipe, and how the
 * process ends. Omit `exit` for a run that stays alive — the ready path, where
 * the helper keeps serving after publishing its port.
 */
export interface AmInstrumentRun {
  stdout?: string[];
  stderr?: string;
  exit?: { code: number | null; signal?: NodeJS.Signals | null };
  /**
   * Leave the stdio pipes open after the exit, so `close` never fires — what a
   * grandchild inheriting stdout (the adb server) does to a real run.
   */
  keepPipesOpen?: boolean;
}

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

export interface FakeAmInstrument {
  /** Drop-in for `child_process.spawn`. */
  spawn: () => FakeChildProcess;
  /** Processes handed out so far, newest last. */
  spawned: FakeChildProcess[];
  /** Queue one run per spawn; the last queued run repeats once the queue empties. */
  queue: (...runs: AmInstrumentRun[]) => void;
}

/**
 * A scriptable stand-in for the `adb shell am instrument` child process the
 * android-devtools blueprint spawns.
 *
 * A failing run emits `exit` with the output still buffered and `close` only
 * once the reader has drained it — node's own ordering, and the reason the
 * blueprint settles on `close`. A reader that judged the run at `exit` sees an
 * empty status block here.
 */
export function fakeAmInstrument(): FakeAmInstrument {
  const queued: AmInstrumentRun[] = [];
  let last: AmInstrumentRun = {};
  const spawned: FakeChildProcess[] = [];

  return {
    spawned,
    queue: (...runs: AmInstrumentRun[]) => queued.push(...runs),
    spawn: () => {
      const run = queued.shift() ?? last;
      last = run;
      const proc = new FakeChildProcess();
      spawned.push(proc);
      setImmediate(() => {
        if (!run.exit) {
          for (const line of run.stdout ?? []) proc.stdout.write(`${line}\n`);
          if (run.stderr) proc.stderr.write(run.stderr);
          return;
        }
        const { code, signal } = run.exit;
        proc.emit("exit", code, signal ?? null);
        for (const line of run.stdout ?? []) proc.stdout.write(`${line}\n`);
        if (run.stderr) proc.stderr.write(run.stderr);
        if (run.keepPipesOpen) return;
        proc.stdout.end();
        proc.stderr.end();
        proc.stdout.on("end", () => setImmediate(() => proc.emit("close", code, signal ?? null)));
      });
      return proc;
    },
  };
}

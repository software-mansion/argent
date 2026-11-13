// A dump started while another runs on the same device is killed (`Killed`,
// exit 137). A read waits up to DUMP_WAIT_MS for the dumps running on its device
// before starting its own: on a screen that never goes idle one dump takes
// ~11.5 s, so past the wait dumps can still overlap.
const DUMP_WAIT_MS = 3_000;
// uiautomator only captures the screen after its process starts and connects,
// so a dump started this recently still reads the screen as it is now.
const JOIN_RUNNING_MS = 500;

interface RunningDump {
  output: Promise<string>;
  startedAt: number;
}

const runningDumps = new Map<string, RunningDump[]>();
const queuedDumps = new Map<string, Promise<string>>();
const neverIdleOutputs = new Map<string, string>();

/**
 * Every `uiautomator dump` on a device goes through here, whichever tool
 * started it. `run` returns the raw dump output and callers validate it
 * themselves, since one dump's output can be handed to several callers.
 *
 * A read joins a dump that started within JOIN_RUNNING_MS. Otherwise, while
 * dumps run on the device, reads share one queued dump that starts once they
 * finish or after DUMP_WAIT_MS. While the last dump on the device reported a
 * never-idle screen, a read behind a running dump gets that output at once
 * instead of waiting for a dump that would fail the same way.
 */
export function queueUiautomatorDump(serial: string, run: () => Promise<string>): Promise<string> {
  const queued = queuedDumps.get(serial);
  if (queued) return queued;
  const running = runningDumps.get(serial) ?? [];
  const newest = running.at(-1);
  if (!newest) return startDump(serial, run);
  if (Date.now() - newest.startedAt < JOIN_RUNNING_MS) return newest.output;
  const neverIdle = neverIdleOutputs.get(serial);
  if (neverIdle !== undefined) return Promise.resolve(neverIdle);

  const next = settleWithin(running, DUMP_WAIT_MS).then(() => {
    queuedDumps.delete(serial);
    return neverIdleOutputs.get(serial) ?? startDump(serial, run);
  });
  queuedDumps.set(serial, next);
  return next;
}

function startDump(serial: string, run: () => Promise<string>): Promise<string> {
  const dump: RunningDump = { output: run(), startedAt: Date.now() };
  runningDumps.set(serial, [...(runningDumps.get(serial) ?? []), dump]);
  const forget = () => {
    const rest = (runningDumps.get(serial) ?? []).filter((d) => d !== dump);
    if (rest.length > 0) runningDumps.set(serial, rest);
    else runningDumps.delete(serial);
  };
  dump.output.then((output) => {
    rememberNeverIdle(serial, output);
    forget();
  }, forget);
  return dump.output;
}

function rememberNeverIdle(serial: string, output: string): void {
  if (/could not get idle state/i.test(output)) neverIdleOutputs.set(serial, output);
  else if (output.includes("<hierarchy")) neverIdleOutputs.delete(serial);
}

function settleWithin(dumps: RunningDump[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const settled = Promise.allSettled(dumps.map((d) => d.output)).then(() => undefined);
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

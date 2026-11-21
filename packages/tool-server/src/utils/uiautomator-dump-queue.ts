import { settleWithin } from "./timing";

// A dump started while another runs on the same device is killed (`Killed`,
// exit 137). A dump on an idle screen ends within DUMP_WAIT_MS; one still
// running after that is waiting out a screen that never goes idle (~11 s), so
// a read waits for a running dump only until the dump is that old.
const DUMP_WAIT_MS = 3_000;
// uiautomator only captures the screen after its process starts and connects,
// so a dump started this recently still reads the screen as it is now.
const JOIN_RUNNING_MS = 500;

interface RunningDump {
  output: Promise<string>;
  startedAt: number;
}

const latestDumps = new Map<string, RunningDump>();
const queuedDumps = new Map<string, Promise<string>>();

/**
 * Every `uiautomator dump` on a device goes through here, whichever tool
 * started it. `run` returns the raw dump output and callers validate it
 * themselves, since one dump's output can be handed to several callers.
 *
 * While the latest dump on the device runs, reads share one queued dump that
 * starts once it finishes or turns DUMP_WAIT_MS old. A read that arrived within
 * JOIN_RUNNING_MS of the running dump's start takes its output instead if it
 * finishes in that time.
 */
export function queueUiautomatorDump(serial: string, run: () => Promise<string>): Promise<string> {
  const queued = queuedDumps.get(serial);
  if (queued) return queued;
  const latest = latestDumps.get(serial);
  if (!latest) return startDump(serial, run);
  const age = Date.now() - latest.startedAt;
  const finished = settleWithin(latest.output, DUMP_WAIT_MS - age);
  if (age < JOIN_RUNNING_MS) {
    return finished.then((dump) =>
      dump.type === "value" ? dump.value : queueUiautomatorDump(serial, run)
    );
  }

  const next = finished.then(() => {
    queuedDumps.delete(serial);
    return startDump(serial, run);
  });
  queuedDumps.set(serial, next);
  return next;
}

function startDump(serial: string, run: () => Promise<string>): Promise<string> {
  const dump: RunningDump = { output: run(), startedAt: Date.now() };
  latestDumps.set(serial, dump);
  const forget = () => {
    if (latestDumps.get(serial) === dump) latestDumps.delete(serial);
  };
  dump.output.then(forget, forget);
  return dump.output;
}

// Watchdog A — the lifeline.
//
// Reads fd 4, the extra pipe the executor opens when it forks this process.
// Nothing is ever written to it: the parent holds one end and the only event
// that matters is that end closing, which happens when the tool server exits
// for any reason. This thread then stops the whole process.
//
// It exists because none of the softer controls reach a runner whose parent
// died. A tool-server process-group stop does not reach a detached runner, and
// the runner's own `disconnect` handler is a main-thread event-loop callback —
// a synchronous infinite loop never yields, so that handler never runs.
// Measured with the disconnect rule implemented exactly, the runner survived
// its parent and kept a core busy for as long as it was watched.
//
// A worker thread is what fixes that, because a worker has its **own** event
// loop on its own OS thread: a main thread spinning in a synchronous loop
// cannot starve it. Measured — with the main thread in an infinite `while`, the
// parent's end was closed at 1500 ms and this thread killed the process 5 ms
// later.
//
// **It reads through the event loop, not `fs.readSync`.** A blocking read looks
// simpler and is a trap: a thread parked inside a synchronous syscall cannot be
// joined, and Node joins its worker threads before leaving. Measured, with the
// blocking form, *every* exit path hung — a passing script's own exit, and a
// script's `process.exit(3)`, both left the process alive until the parent's
// time limit stopped it, turning every script slower than worker startup into a
// timeout. The socket form exits cleanly and preserves the script's exit code
// (measured: 7).
//
// One thread cannot also carry the deadline, and it is the deadline that forces
// the split: `Atomics.wait` blocks its thread outright for the whole time
// limit, so this watchdog sharing it would not see the parent go away until
// that limit had already passed. Nothing here is parked — the handlers below
// wait on socket events and `.resume()` returns at once.

import fs from "node:fs";
import net from "node:net";

const LIFELINE_FD = 4;

const stop = () => {
  // The *group*, not just this process. The runner leads its own group on POSIX
  // precisely so a signal aimed at the group reaches whatever the script
  // started, and this is the path where nothing else can: the tool server is
  // already gone, so its own cleanup will never run and every descendant would
  // otherwise be left behind. Killing the group takes this process with it,
  // which is the point — the main thread it has to stop may be in the very
  // synchronous loop this control exists for.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  process.kill(process.pid, "SIGKILL");
};

try {
  const lifeline = new net.Socket({ fd: LIFELINE_FD, readable: true, writable: false });
  // End of file is reported differently by platform and all of the shapes mean
  // the same thing. Measured on macOS and Linux: the socketpair end reports
  // `end`. Windows is unmeasured — the expectation is that the same condition
  // surfaces as a broken-pipe `error`, since libuv maps ERROR_BROKEN_PIPE to
  // UV_EOF, and that was measured for the `fs.readSync` design this replaced —
  // so all three events are treated as the signal rather than betting on one.
  // The deadline watchdog is the backstop that does not depend on any of this.
  lifeline.on("end", stop);
  lifeline.on("close", stop);
  lifeline.on("error", stop);
  // Flowing mode: the parent never writes, but a paused stream would never
  // reach its own end event.
  lifeline.resume();
} catch (err) {
  // No lifeline on this host. Say so once on stderr — it costs the step a line
  // of log and tells whoever reads the report why an orphan outlived its
  // parent — and leave the deadline watchdog as the backstop.
  fs.writeSync(2, `[argent] script lifeline unavailable: ${err && err.message}\n`);
}

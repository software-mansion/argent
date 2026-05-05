import { spawn } from "child_process";

const NOTIFYUTIL_PATH = "/usr/bin/notifyutil";
const REGISTRATION_DELAY_MS = 300;

export interface NotifyHandle {
  /** Resolves once notifyutil has had time to register its listener with notifyd. */
  ready: Promise<void>;
  /** Resolves when the notification fires (notifyutil exits with code 0). */
  fired: Promise<void>;
  /** Kill the notifyutil child if no longer needed. */
  cancel: () => void;
}

/**
 * Subscribe to a Darwin notification via `/usr/bin/notifyutil -1 <name>`.
 *
 * Darwin notifications are not queued: a fast-starting `xctrace record` can
 * post the notification before a late-spawned listener registers, and the
 * resolve trigger is missed. Callers MUST await `ready` before spawning the
 * notifying process so the listener is live first.
 *
 * `notifyutil -v` only writes to stdout when the notification fires, so we
 * cannot detect the registration boundary by reading bytes. We use a fixed
 * delay matching the timing proven in `ios-profiler-repro/05-notify-tracing-started.sh`.
 * If `notifyutil` fails to spawn at all, `ready` rejects so callers can fall back.
 */
export function listenForDarwinNotification(name: string): NotifyHandle {
  const proc = spawn(NOTIFYUTIL_PATH, ["-v", "-1", name]);

  let firedResolve: () => void = () => {};
  let fired = false;

  const fired$ = new Promise<void>((r) => {
    firedResolve = r;
  });

  let readyResolve: () => void = () => {};
  let readyReject: (e: Error) => void = () => {};
  let readySettled = false;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = () => {
      if (readySettled) return;
      readySettled = true;
      res();
    };
    readyReject = (e) => {
      if (readySettled) return;
      readySettled = true;
      rej(e);
    };
  });

  const registrationTimer = setTimeout(readyResolve, REGISTRATION_DELAY_MS);

  proc.on("exit", (code) => {
    if (!fired && code === 0) {
      fired = true;
      firedResolve();
    }
    // Non-zero exit: never fire. Caller falls back to stdout substring match.
  });
  proc.on("error", (err) => {
    clearTimeout(registrationTimer);
    readyReject(err);
  });

  return {
    ready,
    fired: fired$,
    cancel: () => {
      clearTimeout(registrationTimer);
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    },
  };
}

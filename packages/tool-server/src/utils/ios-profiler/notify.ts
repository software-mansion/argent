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
 * Subscribe to a Darwin notification via `notifyutil -v -1 <name>`.
 *
 * Darwin notifications are not queued: a fast-starting `xctrace record` can post
 * the notification before a late-spawned listener registers, and it is missed.
 * Callers MUST await `ready` before spawning the notifying process.
 *
 * `notifyutil` writes nothing until the notification fires, so registration cannot
 * be observed; `ready` is just a fixed delay. It rejects if the spawn fails.
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

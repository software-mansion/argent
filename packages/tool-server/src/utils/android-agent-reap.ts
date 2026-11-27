import { getFailureSignal } from "@argent/registry";
import { runAdb } from "./adb";

/**
 * Host-side reaper for the on-device screen-sharing agent that
 * `simulator-server android_device` starts through `adb shell` (#1161).
 *
 * The binary is supposed to stop the agent itself. Three cases leave that
 * promise unkept:
 *
 *  - The binary is not pinned. `publish-npm.yml` downloads a rolling
 *    `radon-main` build, so an install can run a simulator-server without any
 *    device-side teardown.
 *  - `SIGKILL` and Windows `TerminateProcess` give the binary no shutdown path.
 *  - The on-device wrapper's trap cannot fire while `app_process` runs in the
 *    foreground, so the agent keeps H.264-encoding into a socket nobody reads.
 *
 * Everything here is scoped to ONE socket name. Android Studio's "Running
 * Devices" mirror runs the same class from the same path, so a broad
 * `pkill -f screensharing.Main` would close the user's mirror. When this
 * session's socket is unknown, nothing is killed.
 */

/** e.g. `127.0.0.1:5555 localabstract:screen-sharing-agent-46527 tcp:46527`. */
const AGENT_SOCKET_RE = /localabstract:(screen-sharing-agent-\d+)/g;

/** Re-checked at the sink: the name is interpolated into a device shell command. */
const SAFE_AGENT_SOCKET = /^screen-sharing-agent-\d+$/;

/** A phone that is unplugged or asleep must not hold a teardown for long. */
const REAP_ADB_TIMEOUT_MS = 5_000;

/**
 * Agent sockets registered in `adb reverse --list`, or null when the probe
 * failed. A failed probe is not an empty set: read as empty, it would make a
 * socket that was there all along (an Android Studio mirror) look like this
 * session's.
 */
export async function listAgentReverseSockets(serial: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await runAdb(["-s", serial, "reverse", "--list"], {
      timeoutMs: REAP_ADB_TIMEOUT_MS,
    });
    return new Set(Array.from(stdout.matchAll(AGENT_SOCKET_RE), (m) => m[1]!));
  } catch {
    return null;
  }
}

/**
 * The one socket `adb reverse --list` gained since `before`, or null when the
 * probe failed, nothing is new, or more than one entry is new (another mirror
 * started in the same window). Only the ambiguous case is logged.
 */
export async function detectAgentSocket(
  serial: string,
  before: ReadonlySet<string>
): Promise<string | null> {
  const after = await listAgentReverseSockets(serial);
  if (after == null) return null;
  const added = [...after].filter((socket) => !before.has(socket));
  if (added.length === 1) return added[0]!;
  if (added.length > 1) {
    process.stderr.write(
      `[argent] cannot tell which screen-sharing agent on ${serial} belongs to this session ` +
        `(${added.length} appeared at once); leaving all of them alone\n`
    );
  }
  return null;
}

/**
 * Stop the agent bound to `socket` and drop its reverse mapping. Best-effort,
 * idempotent, never throws: both calls fail harmlessly when the binary already
 * cleaned up.
 */
export async function reapAndroidScreenSharingAgent(
  serial: string,
  socket: string | null
): Promise<void> {
  if (socket == null || !SAFE_AGENT_SOCKET.test(socket)) return;

  // `[.]`: `pkill -f` matches full argv, and the `sh -c` adbd runs for this
  // command carries the pattern too. An unescaped pattern makes the shell kill
  // itself first. `--socket=` scopes the kill to this session.
  const pkill = runAdb(
    ["-s", serial, "shell", `pkill -f 'screensharing[.]Main.*--socket=${socket}'`],
    { timeoutMs: REAP_ADB_TIMEOUT_MS }
  ).then(
    // Exit 0: a live agent was found, so the binary did not clean up after
    // itself. That is the one outcome worth a line.
    () =>
      process.stderr.write(
        `[argent] stopped a leftover screen-sharing agent on ${serial} (socket ${socket})\n`
      ),
    (err: unknown) => {
      // Exit 1 is "nothing matched", the healthy case.
      if (getFailureSignal(err)?.failure_exit_code === 1) return;
      process.stderr.write(
        `[argent] could not stop the screen-sharing agent on ${serial}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  );
  // "listener not found" is the normal outcome once the binary removed it.
  const unreverse = runAdb(["-s", serial, "reverse", "--remove", `localabstract:${socket}`], {
    timeoutMs: REAP_ADB_TIMEOUT_MS,
  }).catch(() => {});
  await Promise.all([pkill, unreverse]);
}

/**
 * Reaps run in the background, so a phone that stopped answering cannot hold
 * the registry's sequential teardown: the services after it still get their
 * SIGTERM. Shutdown waits for these with `settleAgentReaps`.
 */
const pendingReaps = new Set<Promise<void>>();

export function trackAgentReap(reap: Promise<void>): void {
  const tracked = reap.catch(() => {}).finally(() => pendingReaps.delete(tracked));
  pendingReaps.add(tracked);
}

/** Wait for every reap in flight, for at most `maxMs`. Never rejects. */
export async function settleAgentReaps(maxMs: number): Promise<void> {
  if (pendingReaps.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([...pendingReaps]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs);
    }),
  ]);
  clearTimeout(timer);
}

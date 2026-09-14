import { getFailureSignal } from "@argent/registry";
import { runAdb } from "./adb";

/**
 * Host-side reaper for the on-device screen-sharing agent a physical-Android
 * session runs (`simulator-server android_device`).
 *
 * The simulator-server binary starts `app_process … com.android.tools.screensharing.Main
 * --socket=screen-sharing-agent-<port>` through `adb shell` and is supposed to
 * stop it again. Three cases leave that promise unkept, and this reaper is what
 * covers them:
 *
 *  - The binary is not pinned. `publish-npm.yml` downloads a rolling
 *    `radon-main` build, so an install can be running a simulator-server that
 *    predates any device-side trap. Argent must clean up without it.
 *  - `SIGKILL` and Windows `TerminateProcess` give the binary no chance to run
 *    its own shutdown path at all.
 *  - When adbd holds the reverse socket open, the agent does not notice that
 *    its peer is gone and keeps the phone's screen captured and its CPU busy.
 *
 * Everything here is scoped to ONE socket name. Android Studio's "Running
 * Devices" mirror runs the same class from the same `/data/local/tmp/.studio`
 * path, so a broad `pkill -f screensharing.Main` would kill the user's mirror
 * session. When this session's socket is unknown, the reaper does nothing —
 * an orphan the user can clear by hand is better than killing a window they
 * are looking at.
 */

/**
 * How the agent's device-side socket appears in `adb reverse --list`, e.g.
 * `127.0.0.1:5555 localabstract:screen-sharing-agent-46527 tcp:46527`.
 */
const AGENT_SOCKET_RE = /localabstract:(screen-sharing-agent-\d+)/g;

/**
 * Re-checked at the shell sink: the name is interpolated into a command string
 * the device re-parses through its own shell, and the value reaching here came
 * from `adb`'s stdout rather than from a literal.
 */
const SAFE_AGENT_SOCKET = /^screen-sharing-agent-\d+$/;

/**
 * Short: every call sits on a teardown path the registry awaits one instance at
 * a time. A phone that is unplugged or asleep must not hold that up.
 */
const REAP_ADB_TIMEOUT_MS = 5_000;

/**
 * Screen-sharing-agent sockets currently registered on `serial`, or null when
 * the probe itself failed (device unreachable, `adb` missing, timeout).
 *
 * The null is load-bearing and must not be softened to an empty set. A failed
 * BEFORE snapshot read as "nothing was registered" would make every entry the
 * AFTER snapshot finds look new — including an Android Studio mirror that was
 * there all along, which the reaper would then kill.
 */
export async function listAgentReverseSockets(serial: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await runAdb(["-s", serial, "reverse", "--list"], {
      timeoutMs: REAP_ADB_TIMEOUT_MS,
    });
    const sockets = new Set<string>();
    for (const match of stdout.matchAll(AGENT_SOCKET_RE)) sockets.add(match[1]!);
    return sockets;
  } catch {
    return null;
  }
}

/**
 * The socket this session's agent registered, as the one entry `adb reverse
 * --list` gained since `before` was taken.
 *
 * Returns null when the AFTER probe failed, when the diff is empty (no agent
 * started, or a binary that registers nothing) or when it is ambiguous (>1 new
 * entry — another mirror started in the same window). Every one of those means
 * the reaper must stay its hand.
 *
 * Only the ambiguous case is reported. An empty diff is an ordinary outcome —
 * it happens on every ready-timeout that killed the binary before it reached
 * the device — and a line for it would be noise on a path that is already
 * failing loudly.
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
        `(${added.length} appeared at once); leaving all of them alone. Stop one by hand with ` +
        `\`adb -s ${serial} shell pkill -f 'screensharing[.]Main'\` ` +
        `(this also stops the Android Studio device mirror)\n`
    );
  }
  return null;
}

/**
 * Stop the on-device agent identified by `socket` and drop its reverse mapping.
 *
 * Both steps are best-effort and neither throws: this runs from `dispose`,
 * where the caller has already decided the session is over.
 */
export async function reapAndroidScreenSharingAgent(
  serial: string,
  socket: string | null
): Promise<void> {
  if (socket == null || !SAFE_AGENT_SOCKET.test(socket)) return;

  try {
    /**
     * `screensharing[.]Main` rather than `screensharing\.Main` for one reason:
     * `pkill -f` matches against full argv, and the argv of the very `sh -c`
     * adbd runs for this command contains the pattern — an unescaped pattern
     * makes the shell kill itself before it can kill the agent. A bracket
     * expression matches the agent's literal `screensharing.Main` while the
     * pattern text itself no longer matches the pattern.
     *
     * `--socket=` scopes the kill to this session, leaving an Android Studio
     * mirror on the same device running.
     */
    await runAdb(["-s", serial, "shell", `pkill -f 'screensharing[.]Main.*--socket=${socket}'`], {
      timeoutMs: REAP_ADB_TIMEOUT_MS,
    });
    /**
     * Exit 0 means `pkill` found a live agent and signalled it — so the
     * simulator-server binary did NOT clean up after itself, which is the one
     * outcome here worth a line in the log. Exit 1 ("nothing matched") is the
     * healthy case and stays silent.
     */
    process.stderr.write(
      `[argent] stopped a leftover screen-sharing agent on ${serial} (socket ${socket})\n`
    );
  } catch (err) {
    if (getFailureSignal(err)?.failure_exit_code !== 1) {
      process.stderr.write(
        `[argent] could not stop the screen-sharing agent on ${serial}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  try {
    await runAdb(["-s", serial, "reverse", "--remove", `localabstract:${socket}`], {
      timeoutMs: REAP_ADB_TIMEOUT_MS,
    });
  } catch {
    /**
     * Swallowed whole, exit 1 included: `adb: error: listener '…' not found`
     * is the normal outcome once the simulator-server binary removed the
     * mapping itself or the transport went away with the device. Nothing here
     * distinguishes that from a real failure, and neither changes what the
     * caller does next.
     */
  }
}

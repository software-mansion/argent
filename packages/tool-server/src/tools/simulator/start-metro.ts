import { z } from "zod";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import type { ToolDefinition } from "@argent/registry";

const zodSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8081)
    .describe(
      "TCP port Metro listens on (default 8081). Used to detect/reuse an existing server and to poll for readiness. The default command passes it as --port; for a custom `command`, make sure your script starts Metro on this port."
    ),
  projectRoot: z
    .string()
    .optional()
    .describe(
      "Absolute path to the React Native project root. Sets the working directory for the start command (and --projectRoot for the default command). Defaults to the tool-server working directory."
    ),
  command: z
    .string()
    .optional()
    .describe(
      'Executable to launch Metro with, to run a project\'s custom start script (e.g. "npm", "yarn"). Defaults to "npx react-native start". Run with no shell.'
    ),
  args: z
    .array(z.string())
    .optional()
    .describe(
      'Arguments for `command`, passed verbatim (e.g. ["run", "start:local"]). Ignored unless `command` is set. With a custom command, --port/--projectRoot are NOT auto-added — include any flags your script needs here.'
    ),
  reuseExisting: z
    .boolean()
    .default(true)
    .describe(
      "If a Metro server is already running on the port, reuse it instead of starting a new one (default true). Set false to require a fresh start."
    ),
});

type Params = {
  port: number;
  projectRoot?: string;
  command?: string;
  args?: string[];
  reuseExisting: boolean;
};
type Result = { port: number; pid: number; status: "started" | "reused" };

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 250;
const STATUS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Light Metro liveness probe: just checks the `/status` endpoint for the
 * `packager-status:running` marker. Unlike `discoverMetro`, this does NOT
 * require a connected app or the project-root header, so it returns true for a
 * Metro that has only just come up. Used for both the reuse check and the
 * readiness poll. Returns false on any network/timeout error.
 */
async function probeMetroStatus(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: controller.signal });
    const text = await res.text();
    return text.includes("packager-status:running");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find the pid(s) *listening* on a TCP port via `lsof`. The `-sTCP:LISTEN`
 * filter is essential: a bare `lsof -ti tcp:<port>` also matches established
 * client sockets to that port, so it would return the pid of anything talking
 * to Metro (including this tool-server, which keeps a keep-alive socket open
 * after `probeMetroStatus`) instead of the Metro server itself. We only ever
 * want the process that bound the port.
 * execFileSync (no shell) so `port` can never be shell-interpreted.
 */
function findListeningPids(port: number): number[] {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  } catch {
    // lsof exits non-zero when no process is found on the port
    return [];
  }
}

async function waitForMetroReady(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probeMetroStatus(port)) return;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `start-metro: Metro on port ${port} did not become ready within ${deadlineMs}ms.`
  );
}

/**
 * Resolve the executable + args used to start Metro. A custom `command` runs
 * verbatim (no shell, no flag injection) — the caller owns its port/root flags.
 * Otherwise we run the default `npx react-native start --port <port>`.
 */
function resolveStartCommand(
  port: number,
  projectRoot: string | undefined,
  command: string | undefined,
  args: string[] | undefined
): { cmd: string; cmdArgs: string[] } {
  if (command) {
    return { cmd: command, cmdArgs: args ?? [] };
  }
  return {
    cmd: "npx",
    cmdArgs: [
      "react-native",
      "start",
      "--port",
      String(port),
      ...(projectRoot ? ["--projectRoot", projectRoot] : []),
    ],
  };
}

/**
 * Spawn the Metro start command detached and wait until its `/status` endpoint
 * responds. The child is detached + unref'd so it outlives the tool-server (the
 * simulator-server / boot-electron pattern); `stop-metro` later terminates it
 * by port. Boot-time `error`/`exit` listeners are folded into the readiness
 * race and detached once it settles, so a later natural exit can't reject an
 * orphan promise and crash the tool-server.
 */
async function startMetro(
  port: number,
  projectRoot: string | undefined,
  command: string | undefined,
  args: string[] | undefined
): Promise<Result> {
  const { cmd, cmdArgs } = resolveStartCommand(port, projectRoot, command, args);
  const display = [cmd, ...cmdArgs].join(" ");

  let child: ChildProcess;
  try {
    child = spawn(cmd, cmdArgs, {
      cwd: projectRoot ?? process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
  } catch (err) {
    throw new Error(
      `start-metro: failed to spawn "${display}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  let spawnErrorReject: ((e: Error) => void) | null = null;
  const spawnError = new Promise<never>((_resolve, reject) => {
    spawnErrorReject = reject;
  });
  const spawnErrorListener = (err: NodeJS.ErrnoException) => {
    if (!spawnErrorReject) return;
    const codeSuffix = err.code ? ` (${err.code})` : "";
    spawnErrorReject(
      new Error(
        `start-metro: failed to launch "${display}"${codeSuffix}: ${err.message}. Make sure the command is on PATH and the project has react-native installed.`
      )
    );
  };
  child.once("error", spawnErrorListener);

  if (!child.pid) {
    // spawn failed synchronously (e.g. ENOENT — command not on PATH, or npx
    // missing). Node still emits the spawn 'error' event, but *asynchronously*
    // on a later tick. We must NOT remove `spawnErrorListener` and return here:
    // doing so leaves the deferred 'error' with no handler, so it surfaces as an
    // uncaughtException. The tool-server's handler treats that as a crash and
    // runs crashShutdown → process.exit(1), taking down every concurrent
    // session — not just this start-metro call. Instead keep the listener
    // attached (it's a `once`, so it self-removes after consuming the event) and
    // await the error it surfaces, then reject this call with it. A defensive
    // timeout guards the (Node-guaranteed-not-to-happen) case where no 'error'
    // ever arrives, so we never hang the call indefinitely.
    const spawnFailure = await Promise.race([
      spawnError.catch((e: Error) => e),
      new Promise<Error>((resolve) =>
        setTimeout(
          () => resolve(new Error("start-metro: spawn returned without a pid.")),
          STATUS_PROBE_TIMEOUT_MS
        )
      ),
    ]);
    throw spawnFailure;
  }
  child.unref();

  let earlyExitReject: ((e: Error) => void) | null = null;
  const earlyExit = new Promise<never>((_resolve, reject) => {
    earlyExitReject = reject;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!earlyExitReject) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
    earlyExitReject(
      new Error(`start-metro: Metro process exited with ${reason} before it became ready.`)
    );
  };
  child.once("exit", onExit);

  const detachBootListeners = () => {
    child.removeListener("error", spawnErrorListener);
    child.removeListener("exit", onExit);
    spawnErrorReject = null;
    earlyExitReject = null;
  };

  try {
    await Promise.race([waitForMetroReady(port, READY_TIMEOUT_MS), earlyExit, spawnError]);
  } catch (err) {
    detachBootListeners();
    throw err;
  }
  detachBootListeners();

  // Report the pid that actually bound the port, not `child.pid`. With a
  // wrapper command (`npx`/`npm run`) child.pid is the wrapper, and the real
  // Metro listener is a descendant — so child.pid would not be "the Metro
  // process". Fall back to child.pid only if the listener lookup comes up empty
  // (e.g. a brief race right after readiness).
  const listenerPid = findListeningPids(port)[0] ?? child.pid;
  return { status: "started", port, pid: listenerPid };
}

export const startMetroTool: ToolDefinition<Params, Result> = {
  id: "start-metro",
  description: `Start the Metro bundler for a React Native project, or reuse an instance already running on the port. Runs "npx react-native start --port <port>" detached by default; pass a custom \`command\`/\`args\` (e.g. command "npm", args ["run", "start:local"]) to run a project's own start script verbatim. Returns { port, pid, status } where status is "started" or "reused". With reuseExisting=true (default), an already-running Metro on the port is reused. Set reuseExisting=false to require a fresh start (errors instead of reusing). Fails if the port is occupied by a non-Metro process (free it with stop-metro first), or if Metro does not become ready. Stop a started instance with stop-metro.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { port, projectRoot, command, args, reuseExisting } = params as Params;

    if (projectRoot && !fs.existsSync(projectRoot)) {
      throw new Error(`start-metro: projectRoot does not exist: ${projectRoot}`);
    }

    const metroAlreadyRunning = await probeMetroStatus(port);
    if (metroAlreadyRunning) {
      if (reuseExisting) {
        const pid = findListeningPids(port)[0] ?? 0;
        return { status: "reused", port, pid };
      }
      throw new Error(
        `start-metro: Metro is already running on port ${port}. To force a fresh instance, ask the user to confirm, then run stop-metro and call start-metro again. Or call with reuseExisting=true to reuse the running server.`
      );
    }

    // Not Metro — but something else might be holding the port. Surface that
    // immediately instead of spawning a Metro that would just fail to bind.
    const pids = findListeningPids(port);
    if (pids.length > 0) {
      throw new Error(
        `start-metro: port ${port} is in use by non-Metro process(es) ${pids.join(", ")}. Free the port (e.g. with stop-metro) before starting Metro.`
      );
    }

    return startMetro(port, projectRoot, command, args);
  },
};

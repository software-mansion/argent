import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  isToolsServerHealthy,
  isToolsServerProcessAlive,
  readAllToolsServerStates,
  couldBeOurToolServer,
  readToolsServerState,
  formatToolsServerUrl,
  LINK_URL_SCHEME,
  type ToolsServerPaths,
} from "@argent/tools-client";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type EntryToolsUrl,
  type ResolvedToolsUrl,
  check,
  localArgentCmd,
} from "./doctor-shared.js";

// `argent doctor`: the Tool-server section.

/** What a linked tool-server's `/tools` answer means; null status = no answer. */
export function remoteCheck(
  status: number | null,
  url: string,
  source: ResolvedToolsUrl["source"],
  argentCmd = "argent"
): DoctorCheck {
  const where = `${redactUrl(url)} (${source === "env" ? "ARGENT_TOOLS_URL" : "~/.argent/link.json"})`;
  if (status !== null && status >= 200 && status < 300) {
    return check("ok", `Linked to ${where}, reachable`);
  }
  if (status === 401) {
    return check("error", `Linked to ${where}, which rejects the token (HTTP 401)`, {
      fix:
        source === "env"
          ? "Set ARGENT_AUTH_TOKEN to the token the remote server printed"
          : `Pair again: ${argentCmd} link <the argent:// string argent server start printed>`,
    });
  }
  // The tool-server answers 403 only from its Host guard.
  if (status === 403) {
    return check("error", `Linked to ${where}, which refuses this host name (HTTP 403)`, {
      fix: "Use the host the server was started with (its ARGENT_HOST), or restart it with ARGENT_HOST set to the name you connect with",
    });
  }
  return check(
    "error",
    `Linked to ${where}, ${status === null ? "unreachable" : `HTTP ${status}`}`,
    {
      fix:
        source === "env"
          ? "Start the remote server, or unset ARGENT_TOOLS_URL"
          : `Start the remote server, or run ${argentCmd} unlink`,
    }
  );
}

/** The URL without its credentials, which users paste into bug reports. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "***";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Missing counts as writable: the launcher creates it. */
function isWritableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// The tools client appends `/tools` to the URL as given, so probe the same URL.
async function remoteStatus(url: string, token?: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/tools`, {
      signal: AbortSignal.timeout(2_000),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // An unread body keeps the keep-alive socket (and the process) alive.
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

/**
 * The MCP server reads ARGENT_TOOLS_URL from its entry's env, so an entry with
 * one talks to that tool-server, not the local one this section describes.
 */
export async function entryRemoteChecks(urls: EntryToolsUrl[]): Promise<DoctorCheck[]> {
  return Promise.all(
    urls.map(async ({ editor, url, token }) => {
      const result = remoteCheck(await remoteStatus(url, token), url, "env");
      return {
        ...result,
        label: `${editor} entry: ${result.label.replace("(ARGENT_TOOLS_URL)", "(its env ARGENT_TOOLS_URL)")}`,
        ...(result.fix
          ? {
              fix: result.fix.replace(
                "unset ARGENT_TOOLS_URL",
                "remove ARGENT_TOOLS_URL from the entry"
              ),
            }
          : {}),
      };
    })
  );
}

export async function toolServerSection(
  ctx: DoctorContext,
  running: string,
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];

  if (linked.url?.startsWith(LINK_URL_SCHEME)) {
    checks.push(
      check("error", "ARGENT_TOOLS_URL holds an argent:// pairing string, not a server URL", {
        detail: redactUrl(linked.url),
        fix: `Unset ARGENT_TOOLS_URL and run ${ctx.argentCmd} link <the argent:// string>`,
      })
    );
    return { title: "Tool-server", checks };
  }
  if (linked.url) {
    checks.push(
      remoteCheck(
        await remoteStatus(linked.url, linked.token),
        linked.url,
        linked.source,
        ctx.argentCmd
      )
    );
    return { title: "Tool-server", checks };
  }

  const state = await readToolsServerState(paths.bundlePath);
  const argentDir = path.join(homedir(), ".argent");
  if (!isWritableDir(argentDir)) {
    checks.push(
      check("error", "~/.argent is not writable, so no tool-server can start", {
        detail: "a sudo run can leave it owned by root",
        fix: `sudo chown -R "$USER" ${argentDir}`,
      })
    );
  }
  if (!state) {
    checks.push(check("info", "Not running (starts on the first tool call)"));
  } else {
    const host = state.host ?? "127.0.0.1";
    const url = formatToolsServerUrl(host, state.port);
    const alive = isToolsServerProcessAlive(state.pid);
    const healthy = alive && (await isToolsServerHealthy(state.port, host, 2_000, state.token));
    // `argent server stop` only reaches the server of the install it runs from.
    const stopCmd = paths.installKind === "local" ? localArgentCmd(ctx.projectRoot) : ctx.argentCmd;
    const argentHost = process.env.ARGENT_HOST;
    if (healthy) {
      const stale = state.version && state.version !== running;
      checks.push(
        stale
          ? check("warn", `Running ${url} (pid ${state.pid}) from v${state.version}`, {
              fix: `${stopCmd} server stop (the next tool call starts the current version)`,
            })
          : check("ok", `Running ${url} (pid ${state.pid})`)
      );
    } else if (argentHost && argentHost !== host) {
      // #852: the spawned server binds to ARGENT_HOST, clients dial the recorded host.
      checks.push(
        check(
          "warn",
          `Stale state file (pid ${state.pid}) while ARGENT_HOST=${argentHost} is set`,
          {
            detail: `servers spawned here listen on ${argentHost} but are reached at ${host}, so every tool call respawns one`,
            fix: "Unset ARGENT_HOST; it is meant for argent server start on a remote host",
          }
        )
      );
    } else {
      checks.push(
        check("info", `Stale state file (pid ${state.pid} ${alive ? "unhealthy" : "gone"})`, {
          detail: "the next tool call respawns it",
        })
      );
    }
  }

  // A reused pid (the state file outlived its server) is not a tool-server.
  const foreignPids = new Set(
    (await readAllToolsServerStates())
      .filter(
        ({ state: s }) =>
          s.bundlePath !== paths.bundlePath &&
          isToolsServerProcessAlive(s.pid) &&
          couldBeOurToolServer(s.pid, s.bundlePath)
      )
      .map(({ state: s }) => s.pid)
  );
  if (foreignPids.size > 0) {
    checks.push(
      check("info", `${foreignPids.size} tool-server(s) from other argent installs running`, {
        detail: [...foreignPids].map((pid) => `pid ${pid}`).join(", "),
      })
    );
  }

  return { title: "Tool-server", checks };
}

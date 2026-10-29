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
  permissionFix,
  samePath,
} from "./doctor-shared.js";
import { projectToolServer } from "./doctor-platforms.js";

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
      fix: "Connect with the host the server was started with, or restart it with argent server start --host <the name you connect with>",
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

const SHELL_ENV_NOTE =
  "read from this shell; Codex starts MCP servers without ARGENT_* variables and Gemini drops ARGENT_AUTH_TOKEN, so for those set them in the entry's env";

/** The URL without its credentials, which users paste into bug reports. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password && !parsed.searchParams.has("token")) return url;
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "***");
    return parsed.toString();
  } catch {
    return redactUnparsedUrl(url);
  }
}

/** Anything before an `@` may be a token, e.g. a pairing string missing its scheme. */
function redactUnparsedUrl(url: string): string {
  return url
    .replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/@]+@/i, "$1***@")
    .replace(/([?&]token=)[^&#]*/i, "$1***");
}

/** Wildcard binds are dialed on loopback, as the launcher does. */
function dialHost(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

function isUsableState(state: object): boolean {
  const { pid, port, host } = state as Record<string, unknown>;
  return (
    typeof pid === "number" &&
    typeof port === "number" &&
    (host === undefined || typeof host === "string")
  );
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

// The tools client strips trailing slashes before appending `/tools`, so probe the same URL.
async function remoteStatus(url: string, token?: string): Promise<number | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/tools`, {
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

/** Why the tools client can't fetch from this ARGENT_TOOLS_URL value, if it can't. */
function toolsUrlProblem(url: string): string | null {
  if (url.startsWith(LINK_URL_SCHEME)) return "holds an argent:// pairing string, not a server URL";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not an http:// or https:// URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "is not an http:// or https:// URL";
  }
  if (parsed.username || parsed.password) {
    return "carries credentials, which fetch rejects (the token goes in ARGENT_AUTH_TOKEN)";
  }
  return null;
}

/**
 * The MCP server reads ARGENT_TOOLS_URL from its entry's env, so an entry with
 * one talks to that tool-server, not the local one this section describes.
 */
export async function entryRemoteChecks(
  urls: EntryToolsUrl[],
  argentCmd: string
): Promise<DoctorCheck[]> {
  return Promise.all(
    urls.map(async ({ editor, url, token, unresolved }) => {
      if (unresolved) {
        return check(
          "info",
          `${editor} entry: its env ${unresolved} uses a variable this shell does not set, not verified`,
          {
            detail: redactUrl(url),
            fix: `Set the variable where ${editor} starts argent, or remove ${unresolved} from the entry`,
          }
        );
      }
      const problem = toolsUrlProblem(url);
      if (problem) {
        return check("error", `${editor} entry: its env ARGENT_TOOLS_URL ${problem}`, {
          detail: redactUrl(url),
          fix: `Set it to the server's http://<host>:<port>, or remove it from the entry and run ${argentCmd} link <the argent:// string>`,
        });
      }
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

/**
 * `argent server stop` only reaches the server of the install it runs from:
 * the project's copy, the global on PATH, or else this exact copy (an npx
 * cache, a global whose bin dir is off PATH).
 */
export function stopCommand(ctx: DoctorContext, paths: ToolsServerPaths): string {
  if (paths.installKind === "local") return localArgentCmd(ctx.projectRoot);
  const packageRoot = path.dirname(path.dirname(paths.bundlePath));
  if (ctx.global?.root && !ctx.global.runError && samePath(ctx.global.root, packageRoot)) {
    return "argent";
  }
  const cli = path.join(packageRoot, "dist", "cli.js");
  return `node ${/\s/.test(cli) ? JSON.stringify(cli) : cli}`;
}

export async function toolServerSection(
  ctx: DoctorContext,
  running: string,
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];

  const problem = linked.url && toolsUrlProblem(linked.url);
  if (problem) {
    checks.push(
      check("error", `ARGENT_TOOLS_URL ${problem}`, {
        detail: redactUrl(linked.url!),
        fix: `Unset ARGENT_TOOLS_URL and run ${ctx.argentCmd} link <the argent:// string>`,
      })
    );
    return { title: "Tool-server", checks };
  }
  if (linked.url) {
    const result = remoteCheck(
      await remoteStatus(linked.url, linked.token),
      linked.url,
      linked.source,
      ctx.argentCmd
    );
    const fromShell = linked.source === "env" && result.status === "ok";
    checks.push(fromShell ? { ...result, detail: SHELL_ENV_NOTE } : result);
    return { title: "Tool-server", checks };
  }

  // A local-mode project's entries start its own copy's server.
  const serverPaths = projectToolServer(ctx, paths)?.paths ?? paths;
  const expected = serverPaths.version ?? running;
  const state = await readToolsServerState(serverPaths.bundlePath);
  const argentDir = path.join(homedir(), ".argent");
  const writable = isWritableDir(argentDir);
  if (!writable) {
    checks.push(
      check("error", "~/.argent is not writable, so no tool-server can start", {
        detail: "a sudo run can leave it owned by root",
        fix: permissionFix(argentDir, "u+rwx", { recursive: true }),
      })
    );
  }
  const respawnNote = writable ? "the next tool call respawns it" : "fix ~/.argent above first";
  if (!state) {
    checks.push(
      check("info", writable ? "Not running (starts on the first tool call)" : "Not running")
    );
  } else if (!isUsableState(state)) {
    checks.push(
      check("info", "Unreadable state file (pid, port or host has the wrong type)", {
        detail: writable ? "the next tool call rewrites it" : "fix ~/.argent above first",
      })
    );
  } else {
    const host = state.host ?? "127.0.0.1";
    const url = formatToolsServerUrl(host, state.port);
    const alive = isToolsServerProcessAlive(state.pid);
    const healthy = alive && (await isToolsServerHealthy(state.port, host, 2_000, state.token));
    const stopCmd = stopCommand(ctx, serverPaths);
    // The spawned server trims it and falls back to the default when it is blank.
    const argentHost = process.env.ARGENT_HOST?.trim();
    if (healthy) {
      const stale = state.version && state.version !== expected;
      checks.push(
        stale
          ? check("warn", `Running ${url} (pid ${state.pid}) from v${state.version}`, {
              fix: `${stopCmd} server stop (the next tool call starts the current version)`,
            })
          : check("ok", `Running ${url} (pid ${state.pid})`)
      );
    } else if (argentHost && dialHost(argentHost) !== dialHost(host)) {
      // #852: the spawned server binds to ARGENT_HOST, clients dial the recorded host.
      checks.push(
        check(
          "warn",
          `Stale state file (pid ${state.pid}) while ARGENT_HOST=${argentHost} is set`,
          {
            detail: `servers spawned here listen on ${argentHost} but are reached at ${host}, so every tool call respawns one`,
            fix: "Unset ARGENT_HOST (to serve another host, use argent server start --host)",
          }
        )
      );
    } else if (alive && state.managed !== "autospawn") {
      checks.push(
        check("warn", `Running ${url} (pid ${state.pid}) but not answering`, {
          detail:
            "started by argent server start, so the next tool call starts a second server and leaves this one running",
          fix: `${stopCmd} server stop`,
        })
      );
    } else {
      checks.push(
        check("info", `Stale state file (pid ${state.pid} ${alive ? "unhealthy" : "gone"})`, {
          detail: respawnNote,
        })
      );
    }
  }

  // A reused pid (the state file outlived its server) is not a tool-server.
  const foreignPids = new Set(
    (await readAllToolsServerStates())
      .filter(
        ({ state: s }) =>
          s.bundlePath !== serverPaths.bundlePath &&
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

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  readLinkConfig,
  writeLinkConfig,
  clearLinkConfig,
  formatToolsServerUrl,
  parseLinkTarget,
  type LinkConfig,
} from "@argent/tools-client";
import { parsePort, StartFlagError } from "./server.js";

interface LinkFlags {
  host: string | null;
  port: number | null;
  token: string | null;
  /** Canonical URL when a full http(s):// or argent:// target was given. */
  url: string | null;
  yes: boolean;
  noVerify: boolean;
  help: boolean;
}

interface UnlinkFlags {
  yes: boolean;
  help: boolean;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "::0", ""]);

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function validateHost(raw: string): string {
  const trimmed = raw.trim();
  if (WILDCARD_HOSTS.has(trimmed)) {
    throw new StartFlagError(
      `--host ${trimmed === "" ? '""' : trimmed} is a bind address, not a connect address — use 127.0.0.1 or the actual reachable host.`
    );
  }
  return trimmed;
}

function validateConnectPort(raw: string): number {
  // Reuse parsePort for digits/range, then additionally reject 0 — you can
  // bind to "pick a free port" but never connect to port 0.
  const port = parsePort(raw);
  if (port === 0) {
    throw new StartFlagError(`--port must be 1..65535 for a connect target, got "${raw}"`);
  }
  return port;
}

export function parseLinkFlags(argv: string[]): LinkFlags {
  const flags: LinkFlags = {
    host: null,
    port: null,
    token: null,
    url: null,
    yes: false,
    noVerify: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const takeValue = (name: string): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new StartFlagError(`${name} requires a value`);
      i += 1;
      return v;
    };
    if (tok === "--help" || tok === "-h") {
      flags.help = true;
      continue;
    }
    if (tok === "--yes" || tok === "-y") {
      flags.yes = true;
      continue;
    }
    if (tok === "--no-verify") {
      flags.noVerify = true;
      continue;
    }
    if (tok === "--host") {
      flags.host = validateHost(takeValue("--host"));
      continue;
    }
    if (tok.startsWith("--host=")) {
      flags.host = validateHost(tok.slice("--host=".length));
      continue;
    }
    if (tok === "--port" || tok === "-p") {
      flags.port = validateConnectPort(takeValue("--port"));
      continue;
    }
    if (tok.startsWith("--port=")) {
      flags.port = validateConnectPort(tok.slice("--port=".length));
      continue;
    }
    if (tok === "--token") {
      flags.token = takeValue("--token");
      continue;
    }
    if (tok.startsWith("--token=")) {
      flags.token = tok.slice("--token=".length);
      continue;
    }
    // Positional target: an argent://[<token>@]<host>:<port> pairing string or a
    // full http(s):// URL (for a reverse proxy / tunnel). parseLinkTarget throws
    // on a malformed recognized URL and returns null for anything else.
    if (!tok.startsWith("-")) {
      const parsed = parseLinkTarget(tok);
      if (!parsed) {
        throw new StartFlagError(
          `Unrecognized argument "${tok}". Expected an argent://… pairing string, ` +
            `an http(s):// URL, or flags (see --help).`
        );
      }
      flags.host = validateHost(parsed.host);
      flags.port = validateConnectPort(String(parsed.port));
      flags.url = parsed.url;
      if (parsed.token) flags.token = parsed.token;
      continue;
    }
    throw new StartFlagError(`Unknown flag: ${tok}`);
  }

  return flags;
}

export function parseUnlinkFlags(argv: string[]): UnlinkFlags {
  const flags: UnlinkFlags = { yes: false, help: false };
  for (const tok of argv) {
    if (tok === "--help" || tok === "-h") {
      flags.help = true;
      continue;
    }
    if (tok === "--yes" || tok === "-y") {
      flags.yes = true;
      continue;
    }
    throw new StartFlagError(`Unknown flag: ${tok}`);
  }
  return flags;
}

export function printLinkHelp(): void {
  console.log(`Usage: argent link [<target>] [flags]

Route argent client requests (argent tools / run / mcp) to a remote tool-server
instead of auto-spawning a local one. The target is persisted to ~/.argent/link.json
and survives shell restarts.

<target> may be:
  - argent://[<token>@]<host>:<port>   the string \`argent server start\` prints
  - http(s)://<host>[:<port>][/path]   a full URL — use this for a reverse proxy
                                       or tunnel (ngrok, cloudflared, nginx). The
                                       scheme and any path prefix are preserved;
                                       requests go to <url>/tools.

The easiest LAN path is to paste the connection string from \`argent server start\`:
  argent link argent://<token>@10.0.0.42:3001
For a tunnel, point at its public URL and pass the server's token:
  argent link https://argent.example.com --token <token>

Resolution order for the tool-server URL:
  1. ARGENT_TOOLS_URL environment variable (highest precedence)
  2. ~/.argent/link.json (this command)
  3. Auto-spawn a local tool-server (default)

Flags:
  --host <h>        Remote host or IP to connect to. Prompts interactively if
                    omitted. Wildcards (0.0.0.0, ::) are bind addresses, not
                    connect targets, and are rejected — use 127.0.0.1 or the
                    actual reachable host.
  --port, -p <n>    Remote port (1..65535). Defaults to 3001. Prompts if omitted.
  --token <t>       Bearer token for a server that enforces auth. Usually
                    supplied inside the argent:// string instead.
  --no-verify       Skip the pre-flight GET /tools health check.
  --yes, -y         Non-interactive. Requires --host (port defaults to 3001).
                    Fails if --host is missing.
  --help, -h        Show this help.

Examples:
  argent link argent://ab12…c2@10.0.0.42:3001   Pair from a server-start string.
  argent link https://argent.example.com --token ab12…c2
                                             Link through an HTTPS tunnel/proxy.
  argent link                                Interactive prompts for host and port.
  argent link --host 10.0.0.42 --port 3001   Confirms interactively, then saves.
  argent link --host 10.0.0.42 --token ab12…c2 --yes
                                             Non-interactive, authenticated.
  argent link --host 10.0.0.42 --yes --no-verify
                                             Saves immediately, no health check.

Security:
  The token (if any) is stored 0600 and sent as a bearer header. An http:// link
  has no TLS — treat any non-loopback http link as trusted-network-only. Prefer
  an https:// tunnel/proxy when crossing untrusted networks.

Notes:
  - If ARGENT_TOOLS_URL is also set in your environment, it overrides the link.
  - To stop using the remote target, run \`argent unlink\`.
  - \`argent server start/stop/status\` manage the local tool-server lifecycle
    and are unaffected by linking.
  - Restart your editor (Claude / Cursor / VS Code) afterwards — a running
    \`argent mcp\` process caches the target at startup and won't pick up the
    new link until it's relaunched.
`);
}

export function printUnlinkHelp(): void {
  console.log(`Usage: argent unlink [flags]

Remove the persisted remote tool-server link (~/.argent/link.json) and return
to default local auto-spawn behaviour.

Flags:
  --yes, -y     Skip the confirmation prompt.
  --help, -h    Show this help.

Examples:
  argent unlink         Confirms, then removes the link.
  argent unlink --yes   Removes without confirmation. Safe in scripts.

Notes:
  - No-op (exit 0) if no link is currently set.
  - If ARGENT_TOOLS_URL is also set in your environment, it still takes
    precedence after unlinking — unset it manually for fully local behaviour.
  - This does not stop or start any tool-server process. Use
    \`argent server stop\` if you also want to terminate a running local server.
  - Restart your editor afterwards — a running \`argent mcp\` process won't
    revert to local auto-spawn until it's relaunched.
`);
}

async function promptHost(existing: LinkConfig | null, initial?: string): Promise<string> {
  const hostInput = await p.text({
    message: "Remote host or IP to connect to",
    placeholder: existing?.host ?? "127.0.0.1",
    initialValue: initial ?? existing?.host,
    validate(value) {
      if (!value || !value.trim()) return "Host cannot be empty.";
      const trimmed = value.trim();
      if (WILDCARD_HOSTS.has(trimmed)) {
        return `${trimmed} is a bind address, not a connect address — use 127.0.0.1 or the actual reachable host.`;
      }
    },
  });
  if (p.isCancel(hostInput)) {
    p.cancel("Link cancelled.");
    process.exit(0);
  }
  return (hostInput as string).trim();
}

async function promptPort(existing: LinkConfig | null, initial?: number): Promise<number> {
  const defaultPort = initial ?? existing?.port ?? 3001;
  const portInput = await p.text({
    message: "Remote port",
    placeholder: String(defaultPort),
    initialValue: String(defaultPort),
    validate(value) {
      if (!value || !value.trim()) return "Port cannot be empty.";
      try {
        validateConnectPort(value.trim());
      } catch (err) {
        if (err instanceof StartFlagError) return err.message;
        throw err;
      }
    },
  });
  if (p.isCancel(portInput)) {
    p.cancel("Link cancelled.");
    process.exit(0);
  }
  return validateConnectPort((portInput as string).trim());
}

async function preflightHealth(
  url: string,
  token?: string
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${url}/tools`, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // Drain the (large) /tools body so undici frees the keep-alive socket
    // immediately; an unread body otherwise keeps the socket ref'd until the
    // server's idle keepAliveTimeout (~5s), lingering the command after it's done.
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " — the server requires a token; pass --token or use the argent:// link from `server start`"
          : res.status === 403
            ? " — the server refused this host (DNS-rebinding guard); reach it by its bind host or start it with --host"
            : "";
      return { ok: false, error: `${res.status} ${res.statusText}${hint}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function printRestartHint(): void {
  console.log(
    pc.dim("Restart your editor to apply the change to any running `argent mcp` session.")
  );
}

function printSecurityCaveat(host: string, token: string | undefined, url: string): void {
  if (isLoopback(host)) return;
  const tls = url.startsWith("https://");
  if (tls) {
    // TLS handles transport security; nothing alarming to add beyond the
    // (already required) token for a public endpoint.
    if (!token) {
      process.stderr.write(
        pc.yellow(
          `WARNING: ${host} is reached over HTTPS but with NO token — anyone who can ` +
            `reach the URL can drive the server. Pair with a token.\n`
        )
      );
    }
    return;
  }
  if (token) {
    process.stderr.write(
      pc.dim(
        `Note: ${host} is reached over plain HTTP (bearer-token auth, no TLS). ` +
          `Keep this link to a trusted network or VPN, or front it with an https:// tunnel.\n`
      )
    );
    return;
  }
  process.stderr.write(
    pc.yellow(
      `WARNING: linked target ${host} is non-loopback and has NO token — tool calls ` +
        `travel over plain HTTP with no auth. Treat this link as trusted-network-only, ` +
        `or pair with a token (start the server without --no-auth).\n`
    )
  );
}

export async function link(argv: string[]): Promise<void> {
  let flags: LinkFlags;
  try {
    flags = parseLinkFlags(argv);
  } catch (err) {
    if (err instanceof StartFlagError) {
      console.error(`Error: ${err.message}\n`);
      printLinkHelp();
      process.exit(2);
    }
    throw err;
  }

  if (flags.help) {
    printLinkHelp();
    return;
  }

  if (flags.yes && flags.host === null) {
    console.error("Error: --yes requires --host (port defaults to 3001).\n");
    printLinkHelp();
    process.exit(2);
  }

  const existing = await readLinkConfig();

  // Resolve host
  let host: string;
  if (flags.host !== null) {
    host = flags.host;
  } else {
    p.intro(pc.bgCyan(pc.black(" argent link ")));
    if (existing) {
      p.log.info(`Current link: ${pc.cyan(existing.url)} (${existing.createdAt})`);
    }
    host = await promptHost(existing);
  }

  // Resolve port
  let port: number;
  if (flags.port !== null) {
    port = flags.port;
  } else if (flags.yes) {
    // --yes with --host but no --port → default 3001
    port = 3001;
  } else {
    port = await promptPort(existing);
  }

  // Resolve token: an explicit --token / argent:// URL wins; otherwise reuse
  // the existing link's token when re-pointing at the same target, so a bare
  // `argent link` re-run doesn't silently drop authentication.
  const token: string | undefined =
    flags.token ??
    (existing && existing.host === host && existing.port === port ? existing.token : undefined);

  // A full http(s):// / argent:// target carries its own canonical URL (scheme,
  // optional path); the --host/--port path builds a plain http://host:port.
  let url = flags.url ?? formatToolsServerUrl(host, port);

  // Overwrite confirmation (interactive only)
  if (!flags.yes && existing) {
    if (existing.url === url) {
      p.log.info(`Already linked to ${pc.cyan(url)}.`);
      p.outro("No changes.");
      return;
    }
    const overwrite = await p.confirm({
      message: `Replace existing link ${pc.dim(existing.url)} with ${pc.cyan(url)}?`,
      initialValue: true,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Link cancelled.");
      process.exit(0);
    }
  }

  // Pre-flight health check (unless --no-verify)
  if (!flags.noVerify) {
    while (true) {
      const spinnerActive = !flags.yes;
      let spinner: ReturnType<typeof p.spinner> | null = null;
      if (spinnerActive) {
        spinner = p.spinner();
        spinner.start(`Verifying tool-server at ${url}...`);
      }
      const result = await preflightHealth(url, token);
      if (result.ok) {
        if (spinner) spinner.stop(pc.green("Tool-server reachable."));
        break;
      }

      if (spinner) spinner.stop(pc.red("Verification failed."));
      const detail = result.error ? ` (${result.error})` : "";

      if (flags.yes) {
        // Non-interactive: can't prompt, keep original fail-fast behaviour.
        console.error(
          `Error: pre-flight GET ${url}/tools failed${detail}. ` +
            `Make sure the remote tool-server is running, or pass --no-verify to skip.`
        );
        process.exit(1);
      }

      p.log.error(`pre-flight GET ${url}/tools failed${detail}.`);

      const action = await p.select({
        message: "How would you like to proceed?",
        options: [
          { value: "retry", label: "Retry verification" },
          { value: "modify", label: "Modify host and port, then retry" },
          { value: "skip", label: "Skip verification and save anyway" },
          { value: "cancel", label: "Cancel" },
        ],
        initialValue: "retry",
      });

      if (p.isCancel(action) || action === "cancel") {
        p.cancel("Link cancelled.");
        process.exit(0);
      }
      if (action === "skip") break;
      if (action === "modify") {
        host = await promptHost(existing, host);
        port = await promptPort(existing, port);
        url = formatToolsServerUrl(host, port);
      }
      // "retry" (or after "modify") loops and re-runs preflightHealth.
    }
  }

  const cfg: LinkConfig = {
    url,
    host,
    port,
    createdAt: new Date().toISOString(),
    ...(token ? { token } : {}),
  };
  await writeLinkConfig(cfg);

  if (existing && existing.url !== url) {
    console.log(`${pc.green("✓")} Link updated: ${pc.dim(existing.url)} → ${pc.cyan(url)}`);
  } else {
    console.log(`${pc.green("✓")} Linked: ${pc.cyan(url)}`);
  }
  if (token) console.log(pc.dim("  auth: token stored in ~/.argent/link.json (0600)"));
  printSecurityCaveat(host, token, url);
  if (process.env.ARGENT_TOOLS_URL) {
    console.log(
      pc.yellow(
        `Note: ARGENT_TOOLS_URL=${process.env.ARGENT_TOOLS_URL} is set in your environment ` +
          `and takes precedence over the link.`
      )
    );
  }
  printRestartHint();
}

export async function unlink(argv: string[]): Promise<void> {
  let flags: UnlinkFlags;
  try {
    flags = parseUnlinkFlags(argv);
  } catch (err) {
    if (err instanceof StartFlagError) {
      console.error(`Error: ${err.message}\n`);
      printUnlinkHelp();
      process.exit(2);
    }
    throw err;
  }

  if (flags.help) {
    printUnlinkHelp();
    return;
  }

  const existing = await readLinkConfig();
  if (!existing) {
    console.log("Not currently linked — already using local tool-server.");
    return;
  }

  if (!flags.yes) {
    const confirmed = await p.confirm({
      message: `Remove link to ${pc.cyan(existing.url)}?`,
      initialValue: true,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Unlink cancelled.");
      process.exit(0);
    }
  }

  await clearLinkConfig();

  console.log(`${pc.green("✓")} Unlinked from ${pc.dim(existing.url)}.`);
  if (process.env.ARGENT_TOOLS_URL) {
    console.log(
      pc.yellow(
        `The env var ARGENT_TOOLS_URL is also set in your shell (=${process.env.ARGENT_TOOLS_URL}) ` +
          `and takes precedence — unset it manually if you want fully local behaviour.`
      )
    );
  }
  printRestartHint();
}

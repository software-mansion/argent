import * as path from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile, unlink, chmod } from "node:fs/promises";
import { AUTH_TOKEN_ENV } from "./launcher.js";

const LINK_DIR = path.join(homedir(), ".argent");
const LINK_FILE = path.join(LINK_DIR, "link.json");

export interface LinkConfig {
  /** Consumed verbatim by readers — never re-derived from host/port. */
  url: string;
  host: string;
  port: number;
  createdAt: string;
  /**
   * Sent as `Authorization: Bearer <token>` on every request. Absent for a link
   * to an auth-disabled server (`server start --no-auth`). Secret: the link
   * file is written 0600.
   */
  token?: string;
}

export async function readLinkConfig(): Promise<LinkConfig | null> {
  try {
    const raw = await readFile(LINK_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LinkConfig>;
    if (
      !parsed ||
      typeof parsed.url !== "string" ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      createdAt: parsed.createdAt,
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeLinkConfig(cfg: LinkConfig): Promise<void> {
  await mkdir(LINK_DIR, { recursive: true });
  // Force 0600 (the file may hold a bearer token): writeFile's `mode` applies
  // only on create, so chmod also covers an existing looser file.
  await writeFile(LINK_FILE, JSON.stringify(cfg, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(LINK_FILE, 0o600);
}

export async function clearLinkConfig(): Promise<void> {
  try {
    await unlink(LINK_FILE);
  } catch {
    /* best-effort */
  }
}

export type ToolsUrlSource = "env" | "link" | "none";

export interface ResolvedToolsUrl {
  /** Tool-server URL, or null when no override is configured. */
  url: string | null;
  source: ToolsUrlSource;
  /** From the link file, or from ARGENT_AUTH_TOKEN when source is "env". */
  token?: string;
  /**
   * With source "env", the link config the env var shadows — so callers can warn
   * about the overridden link without changing precedence.
   */
  shadowedLink?: LinkConfig;
}

/**
 * Precedence: ARGENT_TOOLS_URL (token from ARGENT_AUTH_TOKEN) > ~/.argent/link.json
 * (token from the file) > null, where the caller falls back to auto-spawn.
 */
export async function getResolvedToolsUrl(): Promise<ResolvedToolsUrl> {
  const envUrl = process.env.ARGENT_TOOLS_URL;
  if (envUrl) {
    const link = await readLinkConfig();
    const envToken = process.env[AUTH_TOKEN_ENV];
    return {
      url: envUrl,
      source: "env",
      ...(envToken ? { token: envToken } : {}),
      ...(link ? { shadowedLink: link } : {}),
    };
  }
  const link = await readLinkConfig();
  if (link) {
    return { url: link.url, source: "link", ...(link.token ? { token: link.token } : {}) };
  }
  return { url: null, source: "none" };
}

/**
 * True when an env var or link file routes requests to an external tool-server.
 * The MCP server gates auto-spawn and health restarts on it — a remote target
 * must never silently fall back to a local spawn.
 */
export async function isRemoteRouted(): Promise<boolean> {
  const { url } = await getResolvedToolsUrl();
  return url !== null;
}

export const LINK_PATHS = { LINK_DIR, LINK_FILE };

// `argent://[<token>@]<host>:<port>`: the pairing string `argent server start`
// prints and `argent link` consumes. The token rides in the userinfo position so
// the string stays shell-safe (no `#`/`?` that zsh/bash would mangle).

export const LINK_URL_SCHEME = "argent:";

export interface ParsedLinkUrl {
  host: string;
  port: number;
  token?: string;
}

/** Build `argent://[<token>@]<host>:<port>`, bracketing IPv6 literals. */
export function formatLinkUrl(parts: ParsedLinkUrl): string {
  const h =
    parts.host.includes(":") && !parts.host.startsWith("[") ? `[${parts.host}]` : parts.host;
  const auth = parts.token ? `${encodeURIComponent(parts.token)}@` : "";
  return `${LINK_URL_SCHEME}//${auth}${h}:${parts.port}`;
}

/**
 * Parse an `argent://` connection string. Returns null when the input isn't an
 * argent URL, so callers can fall back to treating it as a bare host; throws
 * {@link Error} when it is one but malformed.
 */
export function parseLinkUrl(input: string): ParsedLinkUrl | null {
  if (!input.startsWith(`${LINK_URL_SCHEME}//`)) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(
      `Invalid connection string "${input}" — expected argent://[<token>@]<host>:<port>`
    );
  }
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (!host) throw new Error(`Connection string "${input}" is missing a host.`);
  if (!u.port) throw new Error(`Connection string "${input}" is missing a port.`);
  const port = Number(u.port);
  const token = u.username ? decodeURIComponent(u.username) : undefined;
  return { host, port, ...(token ? { token } : {}) };
}

// `argent link` also accepts a full http(s) URL so it can point at a reverse
// proxy / tunnel (ngrok, cloudflared, nginx) rather than only a bare host:port.

export interface ParsedLinkTarget {
  /** Canonical URL to persist and hit verbatim (no trailing slash). */
  url: string;
  /** Hostname — display, the loopback check, and re-prompt defaults. */
  host: string;
  /** Port — explicit, or the scheme default (443 for https, 80 for http). */
  port: number;
  token?: string;
}

function httpFromHostPort(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Parse a `link` target:
 *   - argent://[<token>@]<host>:<port>  — the server-start pairing string (→ http)
 *   - http://… / https://…              — a full URL (scheme, host, optional port + path)
 *
 * Returns null for anything else (e.g. a bare host, so the caller can fall back
 * to --host/--port). Throws on a recognized-but-malformed URL.
 */
export function parseLinkTarget(input: string): ParsedLinkTarget | null {
  // argent:// → http://host:port (parseLinkUrl throws on a malformed one).
  const argent = parseLinkUrl(input);
  if (argent) {
    return {
      url: httpFromHostPort(argent.host, argent.port),
      host: argent.host,
      port: argent.port,
      ...(argent.token ? { token: argent.token } : {}),
    };
  }

  if (!/^https?:\/\//i.test(input)) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Invalid URL "${input}" — expected http(s)://<host>[:<port>][/path].`);
  }
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (!host) throw new Error(`URL "${input}" is missing a host.`);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  // `u.host` keeps an explicit non-default port; dropping query/fragment and a
  // trailing slash keeps `${url}/tools` composable behind a path-prefix proxy.
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  const url = `${u.protocol}//${u.host}${path}`;
  const token = u.username ? decodeURIComponent(u.username) : undefined;
  return { url, host, port, ...(token ? { token } : {}) };
}

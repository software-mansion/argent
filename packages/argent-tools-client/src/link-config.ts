import * as path from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile, unlink, chmod } from "node:fs/promises";
import { AUTH_TOKEN_ENV } from "./launcher.js";

const LINK_DIR = path.join(homedir(), ".argent");
const LINK_FILE = path.join(LINK_DIR, "link.json");

export interface LinkConfig {
  /** Canonical resolved URL — readers consume this verbatim. */
  url: string;
  host: string;
  port: number;
  createdAt: string;
  /**
   * Bearer token for the remote tool-server, if it enforces auth. Sent as
   * `Authorization: Bearer <token>` on every request. Optional: a link to an
   * auth-disabled server (`server start --no-auth`) has none. Treated as a
   * secret — the link file is written 0600.
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
  // 0600: the file may hold a bearer token. Force the mode (writeFile's `mode`
  // only applies on create, so chmod also covers an existing looser file).
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
    // already gone
  }
}

export type ToolsUrlSource = "env" | "link" | "none";

export interface ResolvedToolsUrl {
  /** Resolved tool-server URL, or null when no override is configured. */
  url: string | null;
  /** Which configuration source produced this URL. */
  source: ToolsUrlSource;
  /**
   * Bearer token for the resolved URL, if any. For source "link" it comes from
   * the link file; for source "env" it comes from ARGENT_AUTH_TOKEN. Undefined
   * when the target is unauthenticated or no override is configured.
   */
  token?: string;
  /**
   * When `source === "env"` and a link file *also* exists, this holds the
   * link config that was shadowed by the env var. Lets callers warn the user
   * that their persisted link is currently being overridden — without changing
   * precedence. Undefined in all other cases.
   */
  shadowedLink?: LinkConfig;
}

/**
 * Resolution order:
 *   1. ARGENT_TOOLS_URL env var (highest precedence) → source: "env"
 *      (token from ARGENT_AUTH_TOKEN, if set)
 *   2. ~/.argent/link.json                            → source: "link"
 *      (token from the link file, if present)
 *   3. null                                           → source: "none"
 *      (caller falls back to auto-spawn)
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
 * Used by the MCP server to gate auto-spawn / health-monitor logic — when a
 * caller chose a remote target, we must NOT silently fall back to a local spawn.
 */
export async function isRemoteRouted(): Promise<boolean> {
  const { url } = await getResolvedToolsUrl();
  return url !== null;
}

export const LINK_PATHS = { LINK_DIR, LINK_FILE };

// ── Connection string (`argent://[<token>@]<host>:<port>`) ──────────────
// A single copy-pasteable pairing string emitted by `argent server start` and
// consumed by `argent link`. The token rides in the URL userinfo position so
// the whole string is shell-safe (no `#`/`?` that zsh/bash would mangle).

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
 * argent URL (so callers can fall back to treating it as a bare host or error).
 * Throws {@link Error} when it *is* an argent URL but is malformed (missing
 * host/port), so the caller can surface a precise message.
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

import * as path from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

const LINK_DIR = path.join(homedir(), ".argent");
const LINK_FILE = path.join(LINK_DIR, "link.json");

export interface LinkConfig {
  /** Canonical resolved URL — readers consume this verbatim. */
  url: string;
  host: string;
  port: number;
  createdAt: string;
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
    };
  } catch {
    return null;
  }
}

export async function writeLinkConfig(cfg: LinkConfig): Promise<void> {
  await mkdir(LINK_DIR, { recursive: true });
  await writeFile(LINK_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
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
 *   2. ~/.argent/link.json                            → source: "link"
 *   3. null                                           → source: "none"
 *      (caller falls back to auto-spawn)
 */
export async function getResolvedToolsUrl(): Promise<ResolvedToolsUrl> {
  const envUrl = process.env.ARGENT_TOOLS_URL;
  if (envUrl) {
    const link = await readLinkConfig();
    return {
      url: envUrl,
      source: "env",
      ...(link ? { shadowedLink: link } : {}),
    };
  }
  const link = await readLinkConfig();
  if (link) return { url: link.url, source: "link" };
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

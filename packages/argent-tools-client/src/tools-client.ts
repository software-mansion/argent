import { ensureToolsServer, type ToolsServerPaths } from "./launcher.js";

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputHint?: string;
  alwaysLoad?: boolean;
  searchHint?: string;
}

export interface ToolInvocationResult {
  data: unknown;
  note?: string;
}

/**
 * The CLI and MCP server each instantiate a client bound to the bundled paths
 * known by the published package. Keeping it as a factory avoids a hidden
 * module-level singleton and makes testing easier.
 */
export interface ToolsClient {
  fetchTools(): Promise<ToolMeta[]>;
  fetchTool(name: string): Promise<ToolMeta | null>;
  callTool(name: string, args: unknown): Promise<ToolInvocationResult>;
  /** Returns the tool-server base URL, spawning it if not yet running. */
  baseUrl(): Promise<string>;
}

export interface CreateToolsClientOptions {
  /** Locations of bundled artifacts. Required when ARGENT_TOOLS_URL is unset. */
  paths?: ToolsServerPaths;
}

export function createToolsClient(options: CreateToolsClientOptions = {}): ToolsClient {
  let cached: string | null = null;

  async function baseUrl(): Promise<string> {
    if (process.env.ARGENT_TOOLS_URL) return process.env.ARGENT_TOOLS_URL;
    if (cached) return cached;
    if (!options.paths) {
      throw new Error(
        "tools-client: cannot spawn tool-server without `paths`; set ARGENT_TOOLS_URL or pass paths to createToolsClient()"
      );
    }
    cached = await ensureToolsServer(options.paths);
    return cached;
  }

  async function fetchTools(): Promise<ToolMeta[]> {
    const url = await baseUrl();
    const res = await fetch(`${url}/tools`);
    if (!res.ok) throw new Error(`GET /tools failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { tools: ToolMeta[] };
    return json.tools;
  }

  async function fetchTool(name: string): Promise<ToolMeta | null> {
    const tools = await fetchTools();
    return tools.find((t) => t.name === name) ?? null;
  }

  async function callTool(name: string, args: unknown): Promise<ToolInvocationResult> {
    const url = await baseUrl();
    const res = await fetch(`${url}/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      error?: string;
      message?: string;
      note?: string;
    };
    if (!res.ok) {
      throw new Error(json.error ?? json.message ?? `${res.status} ${res.statusText}`);
    }
    return { data: json.data, note: json.note };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}

import { ensureToolsServer } from "../launcher.js";

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

let cachedBaseUrl: string | null = null;

async function baseUrl(): Promise<string> {
  if (process.env.ARGENT_TOOLS_URL) return process.env.ARGENT_TOOLS_URL;
  if (cachedBaseUrl) return cachedBaseUrl;
  cachedBaseUrl = await ensureToolsServer();
  return cachedBaseUrl;
}

export async function fetchTools(): Promise<ToolMeta[]> {
  const url = await baseUrl();
  const res = await fetch(`${url}/tools`);
  if (!res.ok) throw new Error(`GET /tools failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { tools: ToolMeta[] };
  return json.tools;
}

export async function fetchTool(name: string): Promise<ToolMeta | null> {
  const tools = await fetchTools();
  return tools.find((t) => t.name === name) ?? null;
}

export async function callTool(name: string, args: unknown): Promise<ToolInvocationResult> {
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

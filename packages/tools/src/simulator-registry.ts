import { ChildProcess } from "node:child_process";
import WebSocket from "ws";

export interface SimulatorEntry {
  proc: ChildProcess;
  udid: string;
  apiUrl: string;
  streamUrl: string;
}

// Binary process registry
const processes = new Map<string, SimulatorEntry>();

// WebSocket connection registry (one persistent WS per UDID)
const connections = new Map<string, WebSocket>();

// ── Process management ──────────────────────────────────────────────────────

export function setProcess(entry: SimulatorEntry): void {
  processes.set(entry.udid, entry);
}

export function getProcess(udid: string): SimulatorEntry | undefined {
  return processes.get(udid);
}

export function deleteProcess(udid: string): void {
  processes.delete(udid);
  const ws = connections.get(udid);
  if (ws) {
    ws.close();
    connections.delete(udid);
  }
}

// ── Spawn function registration ─────────────────────────────────────────────

type SpawnFn = (
  udid: string,
  token?: string,
  signal?: AbortSignal
) => Promise<SimulatorEntry>;

let _spawn: SpawnFn | null = null;

export function registerSpawnFn(fn: SpawnFn): void {
  _spawn = fn;
}

export async function ensureServer(
  udid: string,
  token?: string,
  signal?: AbortSignal
): Promise<SimulatorEntry> {
  const existing = processes.get(udid);
  if (existing) return existing;
  if (!_spawn)
    throw new Error("SimulatorRegistry: spawn function not registered");
  return _spawn(udid, token, signal);
}

// ── WebSocket management ────────────────────────────────────────────────────

function getOrCreateWs(entry: SimulatorEntry): WebSocket {
  const existing = connections.get(entry.udid);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN ||
      existing.readyState === WebSocket.CONNECTING)
  ) {
    return existing;
  }
  const { host } = new URL(entry.apiUrl);
  const ws = new WebSocket(`ws://${host}/ws`);
  ws.on("error", () => connections.delete(entry.udid));
  ws.on("close", () => connections.delete(entry.udid));
  connections.set(entry.udid, ws);
  return ws;
}

let _cmdId = 0;

export function sendCommand(entry: SimulatorEntry, cmd: object): void {
  const ws = getOrCreateWs(entry);
  const payload = JSON.stringify({ id: String(++_cmdId), ...cmd });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    ws.once("open", () => ws.send(payload));
  }
}

// ── Screenshot (HTTP) ───────────────────────────────────────────────────────

export async function httpScreenshot(
  entry: SimulatorEntry,
  rotation?: string,
  signal?: AbortSignal
): Promise<{ url: string; path: string }> {
  const res = await fetch(`${entry.apiUrl}/api/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rotation ? { rotation } : {}),
    signal,
  });
  const body = (await res.json()) as {
    url?: string;
    path?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `screenshot ${res.status}`);
  return { url: body.url!, path: body.path! };
}

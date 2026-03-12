import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const FLOWS_DIR_NAME = ".argent";

// ── Paths ────────────────────────────────────────────────────────────

async function getGitRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  return stdout.trim();
}

export async function getFlowsDir(): Promise<string> {
  const root = await getGitRoot();
  return path.join(root, FLOWS_DIR_NAME);
}

export async function getFlowPath(name: string): Promise<string> {
  const dir = await getFlowsDir();
  return path.join(dir, `${name}.flow`);
}

// ── Active flow state ────────────────────────────────────────────────

let activeFlowName: string | null = null;

export function setActiveFlow(name: string): void {
  activeFlowName = name;
}

export function getActiveFlow(): string {
  if (!activeFlowName) {
    throw new Error("No active flow. Call flow_start first.");
  }
  return activeFlowName;
}

export function clearActiveFlow(): void {
  activeFlowName = null;
}

// ── Serialisation ────────────────────────────────────────────────────

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "echo"; message: string };

export function serializeStep(step: FlowStep): string {
  if (step.kind === "echo") {
    return `echo:${step.message}`;
  }
  return `tool:${step.name} ${JSON.stringify(step.args)}`;
}

function parseLine(line: string): FlowStep {
  if (line.startsWith("echo:")) {
    return { kind: "echo", message: line.slice(5) };
  }
  if (line.startsWith("tool:")) {
    const rest = line.slice(5);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) {
      return { kind: "tool", name: rest, args: {} };
    }
    const name = rest.slice(0, spaceIdx);
    const args = JSON.parse(rest.slice(spaceIdx + 1)) as Record<string, unknown>;
    return { kind: "tool", name, args };
  }
  throw new Error(`Unrecognised flow line: ${line}`);
}

export function parseFlow(content: string): FlowStep[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseLine);
}

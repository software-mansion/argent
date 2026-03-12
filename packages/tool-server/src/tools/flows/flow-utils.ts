import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export const FLOWS_DIR_NAME = ".argent";

/** Returns the git root of the current working directory, or throws. */
export async function getGitRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  return stdout.trim();
}

/** Returns the path to the .argent/ flows directory inside the git root. */
export async function getFlowsDir(): Promise<string> {
  const root = await getGitRoot();
  return path.join(root, FLOWS_DIR_NAME);
}

/** Returns the full path for a named flow file. */
export async function getFlowPath(name: string): Promise<string> {
  const dir = await getFlowsDir();
  return path.join(dir, `${name}.flow`);
}

// ── Active flow state ────────────────────────────────────────────────

let activeFlowName: string | null = null;

/** Set the active flow name (called by flow_start). */
export function setActiveFlow(name: string): void {
  activeFlowName = name;
}

/** Get the active flow name, or throw if none is recording. */
export function getActiveFlow(): string {
  if (!activeFlowName) {
    throw new Error("No active flow. Call flow_start first.");
  }
  return activeFlowName;
}

/** Clear the active flow (called by flow_finish). */
export function clearActiveFlow(): void {
  activeFlowName = null;
}

// ── Flow line types ──────────────────────────────────────────────────

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "echo"; message: string };

/** Serialise a single step to a line in the flow file. */
export function serializeStep(step: FlowStep): string {
  if (step.kind === "echo") {
    return `echo:${step.message}`;
  }
  return `tool:${step.name} ${JSON.stringify(step.args)}`;
}

/** Parse a single line from a flow file into a FlowStep. */
export function parseLine(line: string): FlowStep {
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

/** Parse all non-empty lines of a flow file. */
export function parseFlow(content: string): FlowStep[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseLine);
}

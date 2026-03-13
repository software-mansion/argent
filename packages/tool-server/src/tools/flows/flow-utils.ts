import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

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
  return path.join(dir, `${name}.yaml`);
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

type YamlStep =
  | { echo: string }
  | { tool: string; args?: Record<string, unknown> };

function toYamlStep(step: FlowStep): YamlStep {
  if (step.kind === "echo") {
    return { echo: step.message };
  }
  const hasArgs = Object.keys(step.args).length > 0;
  return hasArgs ? { tool: step.name, args: step.args } : { tool: step.name };
}

function fromYamlStep(raw: YamlStep): FlowStep {
  if ("echo" in raw) {
    return { kind: "echo", message: raw.echo };
  }
  return { kind: "tool", name: raw.tool, args: raw.args ?? {} };
}

/** Serialize a single step as a YAML list item string (with trailing newline). */
export function serializeStep(step: FlowStep): string {
  return yamlStringify([toYamlStep(step)], { flowLevel: 2 }).trimEnd();
}

/** Parse a full YAML flow file into FlowStep[]. */
export function parseFlow(content: string): FlowStep[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  const parsed = yamlParse(trimmed) as YamlStep[];
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid flow file: expected a YAML array");
  }

  return parsed.map((raw) => {
    if ("echo" in raw) return fromYamlStep(raw);
    if ("tool" in raw) return fromYamlStep(raw);
    throw new Error(`Unrecognised flow entry: ${JSON.stringify(raw)}`);
  });
}

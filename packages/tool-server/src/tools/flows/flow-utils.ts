import * as path from "node:path";
import * as fs from "node:fs/promises";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

const FLOWS_DIR_NAME = ".argent";

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Walk up from the current working directory looking for a directory that
 * already contains a `.argent/` entry — that directory is the project root.
 * Falls back to `process.cwd()` so the first `flow-start-recording` call
 * creates `.argent/` in-place.
 */
async function findProjectRoot(): Promise<string> {
  let dir = process.cwd();
  while (true) {
    try {
      const stat = await fs.stat(path.join(dir, FLOWS_DIR_NAME));
      if (stat.isDirectory()) return dir;
    } catch {
      // not found at this level — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export async function getFlowsDir(): Promise<string> {
  const root = await findProjectRoot();
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

/** Returns the active flow name, or null if none is active. */
export function getActiveFlowOrNull(): string | null {
  return activeFlowName;
}

export function getActiveFlow(): string {
  if (!activeFlowName) {
    throw new Error("No active flow. Call flow-start-recording first.");
  }
  return activeFlowName;
}

export function clearActiveFlow(): void {
  activeFlowName = null;
}

// ── Types ────────────────────────────────────────────────────────────

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "echo"; message: string };

export type FlowFile = {
  executionPrerequisite: string;
  steps: FlowStep[];
};

type YamlStep = { echo: string } | { tool: string; args?: Record<string, unknown> };

type YamlFlowFile = {
  executionPrerequisite: string;
  steps: YamlStep[];
};

// ── Conversions ──────────────────────────────────────────────────────

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

// ── Serialisation ────────────────────────────────────────────────────

/** Serialize a full flow file to YAML. */
export function serializeFlow(flow: FlowFile): string {
  const doc: YamlFlowFile = {
    executionPrerequisite: flow.executionPrerequisite,
    steps: flow.steps.map(toYamlStep),
  };
  return yamlStringify(doc);
}

/** Parse a YAML flow file into a FlowFile. */
export function parseFlow(content: string): FlowFile {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { executionPrerequisite: "", steps: [] };
  }

  const parsed = yamlParse(trimmed) as YamlFlowFile;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("steps" in parsed) ||
    !Array.isArray(parsed.steps)
  ) {
    throw new Error("Invalid flow file: expected an object with a steps array");
  }

  const steps = parsed.steps.map((raw) => {
    if ("echo" in raw) return fromYamlStep(raw);
    if ("tool" in raw) return fromYamlStep(raw);
    throw new Error(`Unrecognized flow entry: ${JSON.stringify(raw)}`);
  });

  return {
    executionPrerequisite: parsed.executionPrerequisite ?? "",
    steps,
  };
}

// ── File helpers ─────────────────────────────────────────────────────

/** Read and parse the flow file, append a step, write it back. */
export async function appendStep(filePath: string, step: FlowStep): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  const flow = parseFlow(content);
  flow.steps.push(step);
  const updated = serializeFlow(flow);
  await fs.writeFile(filePath, updated, "utf8");
  return updated;
}

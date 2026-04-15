import * as path from "node:path";
import * as fs from "node:fs/promises";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

const FLOWS_DIR_NAME = ".argent";

// ── Paths ────────────────────────────────────────────────────────────

// ── Active session state ─────────────────────────────────────────────

let activeFlowName: string | null = null;
let activeProjectRoot: string | null = null;

export function setActiveProjectRoot(root: string): void {
  if (!path.isAbsolute(root)) {
    throw new Error(
      `project_root must be an absolute path (got "${root}"). ` +
        `Pass the absolute path to the project root directory — the same cwd ` +
        `the calling agent is working in.`
    );
  }
  activeProjectRoot = root;
}

export function requireActiveProjectRoot(): string {
  if (!activeProjectRoot) {
    throw new Error(
      "No active project root. The calling flow tool must pass project_root before any path is resolved."
    );
  }
  return activeProjectRoot;
}

export function clearActiveProjectRoot(): void {
  activeProjectRoot = null;
}

export function getFlowsDir(): string {
  return path.join(requireActiveProjectRoot(), FLOWS_DIR_NAME);
}

export function getFlowPath(name: string): string {
  return path.join(getFlowsDir(), `${name}.yaml`);
}

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

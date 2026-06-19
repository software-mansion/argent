import * as path from "node:path";
import * as fs from "node:fs/promises";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { CLIENT_FILE_MARKER, type ClientFileDirective } from "@argent/registry";

const FLOWS_DIR_NAME = path.join(".argent", "flows");

// ── Paths ────────────────────────────────────────────────────────────

// ── Active session state ─────────────────────────────────────────────

let activeFlowName: string | null = null;
let activeProjectRoot: string | null = null;

/**
 * Where the active recording's YAML is persisted:
 * - `"host"`   — this process writes `<project_root>/.argent/flows/<name>.yaml`
 *                directly (the original behavior; correct whenever the caller's
 *                project root is on this machine).
 * - `"client"` — the caller's project root is NOT on this machine (remote
 *                tool-server). The flow lives in memory here and every mutating
 *                tool returns a {@link ClientFileDirective} so the *client*
 *                writes the YAML into the agent's project.
 */
export type FlowPersistMode = "host" | "client";

export interface RecordingSession {
  persist: FlowPersistMode;
  /**
   * Absolute path of the flow file as the CALLER knows it. A real host path in
   * "host" mode; in "client" mode it is only echoed back inside the directive
   * (it names a file on the client's machine, never touched here).
   */
  filePath: string;
  /** In-memory flow content — authoritative in "client" mode. */
  flow: FlowFile;
}

let recordingSession: RecordingSession | null = null;

export function setActiveProjectRoot(root: string): void {
  if (!path.isAbsolute(root)) {
    throw new Error(
      `project_root must be an absolute path (got "${root}"). ` +
        `Pass the absolute path to the project root directory — the same cwd ` +
        `the calling agent is working in.`
    );
  }
  // Reject ".." segments: getFlowsDir()/getFlowPath() join the flows dir under
  // this root, and path.join collapses "..", so a root like
  // "/a/../../../etc" would relocate the flows dir (and the validated flow
  // file) outside the intended project.
  if (root.split(/[\\/]+/).includes("..")) {
    throw new Error(`project_root must not contain ".." segments (got "${root}").`);
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

const FLOW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function assertSafeFlowName(name: string): void {
  if (!FLOW_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid flow name "${name}". Flow names must match ${FLOW_NAME_PATTERN} ` +
        `(letters, digits, underscore, hyphen — no path separators, no "..", no spaces).`
    );
  }
}

export function getFlowPath(name: string): string {
  assertSafeFlowName(name);
  const filePath = path.join(getFlowsDir(), `${name}.yaml`);
  // Defense-in-depth: ensure the resolved path stays inside the flows
  // directory even if the regex above is ever weakened.
  const rel = path.relative(getFlowsDir(), filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Invalid flow name "${name}": resolves outside the flows directory.`);
  }
  return filePath;
}

export function setActiveFlow(name: string): void {
  activeFlowName = name;
}

/** Begin a recording session (replacing any abandoned one). */
export function startRecordingSession(name: string, session: RecordingSession): void {
  activeFlowName = name;
  recordingSession = session;
}

export function getRecordingSession(): RecordingSession | null {
  return recordingSession;
}

function requireRecordingSession(): RecordingSession {
  if (!activeFlowName || !recordingSession) {
    throw new Error("No active flow. Call flow-start-recording first.");
  }
  return recordingSession;
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
  recordingSession = null;
}

// ── Types ────────────────────────────────────────────────────────────

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown>; delayMs?: number }
  | { kind: "echo"; message: string };

export type FlowFile = {
  executionPrerequisite: string;
  steps: FlowStep[];
};

type YamlStep =
  | { echo: string }
  | { tool: string; args?: Record<string, unknown>; delayMs?: number };

type YamlFlowFile = {
  executionPrerequisite: string;
  steps: YamlStep[];
};

// ── Conversions ──────────────────────────────────────────────────────

function toYamlStep(step: FlowStep): YamlStep {
  if (step.kind === "echo") {
    return { echo: step.message };
  }
  const yaml: { tool: string; args?: Record<string, unknown>; delayMs?: number } = {
    tool: step.name,
  };
  if (Object.keys(step.args).length > 0) yaml.args = step.args;
  if (step.delayMs !== undefined) yaml.delayMs = step.delayMs;
  return yaml;
}

function fromYamlStep(raw: YamlStep): FlowStep {
  if ("echo" in raw) {
    return { kind: "echo", message: raw.echo };
  }
  const step: FlowStep = { kind: "tool", name: raw.tool, args: raw.args ?? {} };
  if (raw.delayMs !== undefined) step.delayMs = raw.delayMs;
  return step;
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

export function clientFileDirective(filePath: string, content: string): ClientFileDirective {
  return { [CLIENT_FILE_MARKER]: true, path: filePath, content };
}

/**
 * How a mutating flow tool reports persistence: a plain host path in "host"
 * mode (nothing for the client to do), or a {@link ClientFileDirective} the
 * client resolves by writing the YAML into the agent's project. Either way the
 * field reads as the flow file's path once the client has processed the result.
 */
export type FlowSavedTo = string | ClientFileDirective;

/**
 * Append a step to the active recording and persist it. In "host" mode the
 * file on disk is re-read first (the original behavior — a manual edit made
 * mid-recording is honored); in "client" mode this process never sees the
 * client's disk, so the in-memory copy is authoritative and the updated YAML
 * travels back in the directive.
 */
export async function appendStepToActiveFlow(
  step: FlowStep
): Promise<{ flowFile: string; savedTo: FlowSavedTo; session: RecordingSession }> {
  const session = requireRecordingSession();
  if (session.persist === "host") {
    const flowFile = await appendStep(session.filePath, step);
    session.flow = parseFlow(flowFile);
    return { flowFile, savedTo: session.filePath, session };
  }
  session.flow.steps.push(step);
  const flowFile = serializeFlow(session.flow);
  return { flowFile, savedTo: clientFileDirective(session.filePath, flowFile), session };
}

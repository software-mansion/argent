import { randomUUID } from "node:crypto";
import { isCi } from "./ci-detect.js";

// Build-time version metadata injected by esbuild; source tests fall back to "0.0".
declare const ARGENT_CLI_VERSION_MAJOR_MINOR: string | undefined;

// Process-local session id. Never persisted or reused across Node processes.
let SESSION_ID: string = randomUUID();

function readCliVersionMajorMinor(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromDefine = (globalThis as any).ARGENT_CLI_VERSION_MAJOR_MINOR;
  if (typeof fromDefine === "string" && fromDefine !== "") return fromDefine;
  if (typeof ARGENT_CLI_VERSION_MAJOR_MINOR === "string" && ARGENT_CLI_VERSION_MAJOR_MINOR !== "") {
    return ARGENT_CLI_VERSION_MAJOR_MINOR;
  }
  return "0.0";
}

function readNodeVersionMajor(): string {
  // process.version is "vMAJOR.MINOR.PATCH"
  const m = /^v?(\d+)/.exec(process.version);
  return m ? m[1]! : "unknown";
}

export type Runtime = "installer" | "tool_server" | "cli" | "mcp";

export interface BaseProps {
  cli_version_major_minor: string;
  node_version_major: string;
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
  is_tty: boolean;
  is_ci: boolean;
  runtime: Runtime;
  $session_id: string;
  $process_person_profile: false;
}

// Keep version metadata coarse to avoid high-resolution fingerprints.
export function getBaseProps(runtime: Runtime): BaseProps {
  return {
    cli_version_major_minor: readCliVersionMajorMinor(),
    node_version_major: readNodeVersionMajor(),
    os: process.platform,
    arch: process.arch,
    is_tty: Boolean(process.stdout.isTTY),
    is_ci: isCi(),
    runtime,
    $session_id: SESSION_ID,
    $process_person_profile: false,
  };
}

export function getSessionId(): string {
  return SESSION_ID;
}

/** Test seam: regenerate the process-local session id. */
export function _resetSessionIdForTest(): void {
  SESSION_ID = randomUUID();
}

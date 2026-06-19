import { randomUUID } from "node:crypto";
import { isCi } from "./ci-detect.js";

// Build-time version metadata injected by esbuild's `define`. It substitutes the
// bare `ARGENT_CLI_VERSION` identifier below with a string literal in the bundle;
// unbundled source (tests) leaves it undefined and falls back to "0.0.0". A
// `globalThis.ARGENT_CLI_VERSION` member read is intentionally NOT used here:
// esbuild only rewrites the bare identifier, not property accesses, so such a
// read would always be undefined.
declare const ARGENT_CLI_VERSION: string | undefined;

// Process-local session id. Never persisted or reused across Node processes.
let SESSION_ID: string = randomUUID();

function readCliVersion(): string {
  if (typeof ARGENT_CLI_VERSION === "string" && ARGENT_CLI_VERSION !== "") {
    return ARGENT_CLI_VERSION;
  }
  return "0.0.0";
}

function readNodeVersionMajor(): string {
  // process.version is "vMAJOR.MINOR.PATCH"
  const m = /^v?(\d+)/.exec(process.version);
  return m ? m[1]! : "unknown";
}

export type Runtime = "installer" | "tool_server" | "cli";

export interface BaseProps {
  cli_version: string;
  node_version_major: string;
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
  is_tty: boolean;
  is_ci: boolean;
  runtime: Runtime;
  $session_id: string;
  $process_person_profile: false;
}

export function getBaseProps(runtime: Runtime): BaseProps {
  return {
    cli_version: readCliVersion(),
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

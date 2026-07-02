import { randomUUID } from "node:crypto";
import { detectCloudAgent, type CloudAgent } from "./cloud-agent-detect.js";
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
  // Canonical slug of the detected cloud/remote AI coding-agent runtime, or null.
  // The agent-environment analogue of is_ci — see ./cloud-agent-detect.ts. Fires
  // only for vendor-hosted/remote runs, not local agent CLI use.
  cloud_agent: CloudAgent | null;
  runtime: Runtime;
  $session_id: string;
  $process_person_profile: false;
}

// Everything here is constant for the process lifetime. Computing it once
// matters for the long-lived tool-server, which calls getBaseProps() on every
// tracked event: readCliVersion(), the process.version regex, and especially
// isCi() (which scans ~9 env vars and walks every ci-info vendor definition) and
// detectCloudAgent() (which scans the agent signal table and may stat the
// Devin/Jules markers) would otherwise re-run per event. Only `runtime` and
// `$session_id` are kept
// dynamic below — the session id reads SESSION_ID live so the test seam can
// rotate it.
type InvariantProps = Omit<BaseProps, "runtime" | "$session_id">;
let invariantProps: InvariantProps | null = null;

function getInvariantProps(): InvariantProps {
  if (!invariantProps) {
    invariantProps = {
      cli_version: readCliVersion(),
      node_version_major: readNodeVersionMajor(),
      os: process.platform,
      arch: process.arch,
      is_tty: Boolean(process.stdout.isTTY),
      is_ci: isCi(),
      cloud_agent: detectCloudAgent(),
      $process_person_profile: false,
    };
  }
  return invariantProps;
}

export function getBaseProps(runtime: Runtime): BaseProps {
  return {
    ...getInvariantProps(),
    runtime,
    $session_id: SESSION_ID,
  };
}

/** Test seam: drop the memoized invariant block so env changes take effect. */
export function _resetBasePropsCacheForTest(): void {
  invariantProps = null;
}

export function getSessionId(): string {
  return SESSION_ID;
}

/** Test seam: regenerate the process-local session id. */
export function _resetSessionIdForTest(): void {
  SESSION_ID = randomUUID();
}

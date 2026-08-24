import { randomUUID } from "node:crypto";
import { detectCloudAgent, type CloudAgent } from "./cloud-agent-detect.js";
import { isCi } from "./ci-detect.js";

// esbuild `define` substitutes this bare identifier with a string literal at
// build time; unbundled source (tests) leaves it undefined. It must stay a bare
// identifier — esbuild rewrites identifiers, not property accesses.
declare const ARGENT_CLI_VERSION: string | undefined;

// Never persisted or reused across Node processes.
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
  // Vendor-hosted/remote agent runtime slug; null for local agent CLI use.
  // See ./cloud-agent-detect.ts.
  cloud_agent: CloudAgent | null;
  runtime: Runtime;
  session_id: string;
}

// Constant for the process lifetime, and memoized because the long-lived
// tool-server calls getBaseProps() on every tracked event: isCi() walks every
// ci-info vendor definition and detectCloudAgent() may stat the Devin/Jules
// markers. `session_id` stays a live read of SESSION_ID so the test seam can
// rotate it.
type InvariantProps = Omit<BaseProps, "runtime" | "session_id">;
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
    };
  }
  return invariantProps;
}

export function getBaseProps(runtime: Runtime): BaseProps {
  return {
    ...getInvariantProps(),
    runtime,
    session_id: SESSION_ID,
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

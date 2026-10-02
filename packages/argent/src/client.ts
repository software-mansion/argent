/**
 * `@swmansion/argent/client`: call argent tools from Node. Talks to the same
 * tool-server as `argent run` and the MCP server, starting it when none is
 * running, and honours `argent link` / `ARGENT_TOOLS_URL` the same way.
 *
 * The public types are declared here rather than re-exported, so the emitted
 * client.d.ts references no private workspace package.
 */
import { FLAG_REGISTRY, isFeatureEnabled } from "@argent/configuration-core";
import {
  createToolsClient,
  getDeviceIdFromArgs,
  killToolServer,
  materializeArtifacts,
  readToolsServerState,
  ToolInvocationError,
} from "@argent/tools-client";
import { BUNDLED_RUNTIME_PATHS } from "./bundled-paths.js";

export interface ArgentTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ArgentToolResult<T = unknown> {
  /** The tool's result. Artifacts (screenshots, recordings) are local file paths. */
  data: T;
  /** Optional advisory note the tool attached to the result. */
  note?: string;
}

export interface CallToolOptions {
  /** Receive progress events while a long-running tool works. */
  onProgress?: (event: unknown) => void;
}

/** The tool-server rejected or failed a call. */
export class ArgentToolError extends Error {
  /** Stable failure code, when the server sent one. */
  readonly code?: string;
  /** Failure category, e.g. "subprocess", when the server sent one. */
  readonly kind?: string;
  /** Schema issues of a rejected argument object; set only on a validation failure. */
  readonly issues?: readonly unknown[];
  constructor(
    message: string,
    details: { code?: string; kind?: string; issues?: readonly unknown[] } = {}
  ) {
    super(message);
    this.name = "ArgentToolError";
    this.code = details.code;
    this.kind = details.kind;
    this.issues = details.issues;
  }
}

export interface ArgentFlag {
  name: string;
  description: string;
  /** Effective state, as `argent flags` reports it. */
  enabled: boolean;
}

/** Feature flags and their effective state: project overrides global, then the default. */
export function listFlags(): ArgentFlag[] {
  return FLAG_REGISTRY.map(({ name, description }) => ({
    name,
    description,
    enabled: isFeatureEnabled(name),
  }));
}

export interface ArgentClient {
  listTools(): Promise<ArgentTool[]>;
  callTool<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions
  ): Promise<ArgentToolResult<T>>;
  /**
   * Stop this install's local tool-server, like `argent server stop`. The next
   * call starts a fresh one. Resolves false when none was running.
   */
  stopServer(): Promise<boolean>;
}

export function createArgentClient(): ArgentClient {
  let client = createToolsClient({ paths: BUNDLED_RUNTIME_PATHS });

  async function stopServer(): Promise<boolean> {
    const running = (await readToolsServerState(BUNDLED_RUNTIME_PATHS.bundlePath)) !== null;
    await killToolServer(BUNDLED_RUNTIME_PATHS.bundlePath);
    // The tools client caches the server it reached; drop it with the server.
    client = createToolsClient({ paths: BUNDLED_RUNTIME_PATHS });
    return running;
  }

  async function listTools(): Promise<ArgentTool[]> {
    const tools = await client.fetchTools();
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async function callTool<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: CallToolOptions
  ): Promise<ArgentToolResult<T>> {
    try {
      const response = await client.callTool(name, args, options);
      // Same artifact handling as `argent run`: a handle becomes a local path,
      // read in place when the tool-server shares this filesystem and
      // downloaded otherwise.
      const { url, token } = await client.baseUrl();
      const { result } = await materializeArtifacts(response.data, {
        toolsUrl: url,
        authToken: token,
        deviceId: getDeviceIdFromArgs(args),
      });
      return { data: result as T, note: response.note };
    } catch (err) {
      if (err instanceof ToolInvocationError) {
        throw new ArgentToolError(err.message, {
          code: err.errorCode,
          kind: err.errorKind,
          issues: err.issues,
        });
      }
      throw err;
    }
  }

  return { listTools, callTool, stopServer };
}

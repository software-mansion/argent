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
  ToolInvocationError,
} from "@argent/tools-client";
import { BUNDLED_RUNTIME_PATHS } from "./bundled-paths.js";
import type { ArgentToolArgs } from "./tool-args.generated.js";

export type { ArgentToolArgs };
export type ArgentToolName = keyof ArgentToolArgs;

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

/**
 * A node of the `ui-tree` result. A flag is set only when true; a field named in
 * `UiTree.unsupportedFields` is unknown when absent.
 */
export interface UiTreeNode {
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  checked?: boolean;
  disabled?: boolean;
  password?: boolean;
  focused?: boolean;
  selected?: boolean;
  /** Normalized to `screen` like gesture-tap, but not clamped: it can fall outside 0..1. */
  frame?: { x: number; y: number; width: number; height: number };
  /** Android: the view class. iOS: the XCUIElementType name, e.g. `TextField`. */
  type?: string;
  /** iOS: the accessibility trait names. */
  traits?: string[];
  roleDescription?: string;
  /** Android: the raw content-desc. */
  contentDescription?: string;
  /** Roots: the app's bundle id (iOS) or package (Android). */
  bundleId?: string;
  editable?: boolean;
  heading?: boolean;
  /** On screen, but behind an in-app presentation (iOS) or a system alert. */
  covered?: boolean;
  placeholder?: string;
  /** The input shows its placeholder: it holds no text, and `value` is unset. */
  hintShowing?: boolean;
  /** No part of the frame is on screen inside its ancestors: scrolled out or clipped. */
  hidden?: boolean;
  children: UiTreeNode[];
}

export interface UiTree {
  schemaVersion: 1;
  source: "ax-service" | "android-devtools";
  /** Native units: iOS points, Android pixels. */
  screen?: { width: number; height: number };
  /**
   * iOS: while a system alert shows, the system app first and the app it covers
   * second. Android: one root per window, topmost first.
   */
  roots: UiTreeNode[];
  truncated: boolean;
  alertVisible?: boolean;
  keyboardVisible?: boolean;
  /**
   * The bundle id or package of the app in front, under any system alert.
   * Android: unset when the alert hides the app's window.
   */
  foregroundApp?: string;
  /**
   * Fields this source cannot report. On Android they depend on the API level:
   * `placeholder` and `hintShowing` need 26, `heading` 28.
   */
  unsupportedFields: string[];
}

export interface CallToolOptions {
  /** Receive progress events while a long-running tool works. */
  onProgress?: (event: unknown) => void;
  /** Stop waiting for the call. It rejects with the signal's reason, not ArgentToolError. */
  signal?: AbortSignal;
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

/** `args` may be omitted only when the tool has no required argument. */
type CallToolParams<N extends ArgentToolName> =
  Record<never, never> extends ArgentToolArgs[N]
    ? [args?: ArgentToolArgs[N], options?: CallToolOptions]
    : [args: ArgentToolArgs[N], options?: CallToolOptions];

export interface ArgentClient {
  listTools(options?: { signal?: AbortSignal }): Promise<ArgentTool[]>;
  callTool<N extends ArgentToolName, T = unknown>(
    name: N,
    ...params: CallToolParams<N>
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
    const stopped = await killToolServer(BUNDLED_RUNTIME_PATHS.bundlePath);
    // The tools client caches the server it reached; drop it with the server.
    client = createToolsClient({ paths: BUNDLED_RUNTIME_PATHS });
    return stopped;
  }

  async function listTools(options?: { signal?: AbortSignal }): Promise<ArgentTool[]> {
    const tools = await client.fetchTools({ signal: options?.signal });
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async function callTool<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: CallToolOptions
  ): Promise<ArgentToolResult<T>> {
    try {
      const response = await client.callTool(name, args, options);
      const { url, token } = await client.baseUrl();
      // Aborted after the reply: skip materialization, which can copy or download files.
      options?.signal?.throwIfAborted();
      // Same artifact handling as `argent run`: a handle becomes a local path,
      // read in place when the tool-server shares this filesystem and
      // downloaded otherwise.
      const { result } = await materializeArtifacts(response.data, {
        toolsUrl: url,
        authToken: token,
        deviceId: getDeviceIdFromArgs(args),
        signal: options?.signal,
      });
      // An aborted download reads as a missing file; report the abort instead.
      options?.signal?.throwIfAborted();
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

import { TypedEventEmitter } from "./event-emitter";
import { z } from "zod";

// ── Service Types ──

export enum ServiceState {
  IDLE = "IDLE",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  TERMINATING = "TERMINATING",
  ERROR = "ERROR",
}

export type ServiceEvents = {
  terminated: (error?: Error) => void;
};

export interface ServiceInstance<T = unknown> {
  api: T;
  dispose(): Promise<void>;
  events: TypedEventEmitter<ServiceEvents>;
}

/** URN (Uniform Resource Name) for parameterized service instances, e.g. "sim-server:device1". */
export type URN = string;

/**
 * Service blueprint: template for creating context-aware service instances.
 * getURN(context) produces the instance URN; getDependencies(context) returns alias→URN for deps;
 * factory receives resolved deps, context payload, and optional resolve options.
 */
export interface ServiceBlueprint<T = unknown, C = unknown> {
  namespace: string;
  getURN(context: C): URN;
  getDependencies?(context: C): Record<string, string>;
  factory(
    deps: Record<string, unknown>,
    context: C,
    options?: Record<string, unknown>
  ): Promise<ServiceInstance<T>>;
}

/**
 * Service node: URN-keyed instance. Keys in the registry are full URNs; node holds blueprint + urn.
 */
export interface ServiceNode<T = unknown> {
  urn: URN;
  blueprint: ServiceBlueprint<T, unknown>;
  state: ServiceState;
  instance: ServiceInstance<T> | null;
  initPromise: Promise<T> | null;
  dependents: Set<string>;
}

/** Per-service reference: URN string or URN + resolve options for factory. */
export type ServiceRef = string | { urn: string; options?: Record<string, unknown> };

/** Options passed to tool execution (e.g. AbortSignal for request cancellation). */
export interface InvokeToolOptions {
  signal?: AbortSignal;
}

/**
 * Host binaries a tool cannot run without. The HTTP dispatcher checks each
 * entry against `PATH` before invoking the tool and returns a pretty
 * install-hint error if any are missing, so tools that shell out to platform
 * SDKs never fail with a raw ENOENT deep in a child-process call.
 *
 * `"xcrun"` covers the Xcode command-line tools (simctl, xctrace, …);
 * `"adb"` covers the Android SDK Platform Tools.
 *
 * Use for tools that are *always* on one platform. Cross-platform tools (e.g.
 * launch-app, describe) should leave this unset and call the `ensureDep`
 * helper *after* `classifyDevice` routes them to the iOS or Android branch.
 */
export type ToolDependency = "adb" | "xcrun";

// ── Tool Types ──

export interface ToolDefinition<TParams = void, TResult = unknown> {
  id: string;
  description?: string;
  /** Zod schema for tool input; used for runtime validation. When provided, inputSchema is auto-derived at registration time. */
  zodSchema?: z.ZodObject<any>;
  /** JSON Schema for tool input; used for listing (GET /tools). Auto-derived from zodSchema if not explicitly set. */
  inputSchema?: Record<string, unknown>;
  /** Optional hint for adapters (e.g. "image" for MCP to return base64 image content). */
  outputHint?: string;
  /** Host binaries that must be on PATH. Checked by the HTTP dispatcher before `execute` runs. */
  requires?: ToolDependency[];
  /**
   * When true, the MCP adapter marks the tool with `_meta["anthropic/alwaysLoad"] = true`
   * so Claude Code opts it out of progressive tool loading (ToolSearch). Use for the
   * handful of tools the model needs on every turn (discovery + core interactions).
   */
  alwaysLoad?: boolean;
  /**
   * Short phrase used by Claude Code's ToolSearch BM25 ranker to surface the tool
   * for relevant queries without needing the full description in context. Forwarded
   * via `_meta["anthropic/searchHint"]`.
   */
  searchHint?: string;
  /** Returns alias → URN or { urn, options }; registry resolves each and passes alias → API into execute. */
  services: (params: TParams) => Record<string, ServiceRef>;
  execute(
    services: Record<string, unknown>,
    params: TParams,
    options?: InvokeToolOptions
  ): Promise<TResult>;
}

export interface ToolRecord {
  definition: ToolDefinition<any, any>;
}

// ── Registry Events ──

export type RegistryEvents = {
  serviceStateChange: (serviceId: string, from: ServiceState, to: ServiceState) => void;
  serviceError: (serviceId: string, error: Error) => void;
  serviceRegistered: (serviceId: string) => void;
  toolRegistered: (toolId: string) => void;
  toolInvoked: (toolId: string) => void;
  toolCompleted: (toolId: string, durationMs: number) => void;
  toolFailed: (toolId: string, error: Error) => void;
};

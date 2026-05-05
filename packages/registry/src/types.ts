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

// ── Device + Capability Types ──

export type Platform = "ios" | "android";

export type DeviceKind = "simulator" | "emulator" | "device" | "unknown";

/**
 * Universal device handle. Platform-aware tools resolve a `udid` parameter into
 * a `DeviceInfo` and use it to dispatch to the right per-platform implementation.
 */
export interface DeviceInfo {
  id: string;
  platform: Platform;
  kind: DeviceKind;
  name?: string;
  state?: string;
  avdName?: string | null;
  sdkLevel?: number | null;
}

/**
 * Per-platform support matrix. A tool with no `apple` block does not run on
 * iOS; a tool with `apple: { simulator: true }` runs on iOS simulators only.
 * The optional `supports` predicate refines further (e.g. exclude tvOS).
 */
export interface ToolCapability {
  apple?: {
    simulator?: boolean;
    device?: boolean;
  };
  android?: {
    emulator?: boolean;
    device?: boolean;
    unknown?: boolean;
  };
  /** Optional refiner. Returns true if this device is supported. */
  supports?: (device: DeviceInfo) => boolean;
}

/**
 * Host binaries (e.g. `xcrun`, `adb`) that a tool — or a per-platform branch
 * of a tool — cannot run without.
 *
 * Two declaration sites:
 *
 * - `ToolDefinition.requires` (global): probed by the HTTP dispatcher BEFORE
 *   any execution. Use only for tools that need this binary on *every*
 *   invocation regardless of the resolved device — rare; usually true only
 *   for analysis / no-device tools that always shell out.
 *
 * - `PlatformImpl.requires` (per-platform branch): probed by `dispatchByPlatform`
 *   AFTER the device is classified, so an iOS-only environment never trips an
 *   `adb` preflight just because a tool *could* run on Android. This is the
 *   right place for cross-platform tools where iOS needs `xcrun` and Android
 *   needs `adb`.
 *
 * On a missing binary, the HTTP layer returns 424 Failed Dependency with an
 * install hint the agent can surface verbatim.
 */
export type ToolDependency = "adb" | "xcrun" | "emulator";

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
  /** Per-platform support declaration. Cross-platform tools assert against this before dispatching. */
  capability?: ToolCapability;
  /**
   * Host binaries that must be on PATH for *every* invocation of this tool.
   * Probed by the HTTP dispatcher before `execute` runs; rejects with 424.
   * For cross-platform tools whose binary requirements differ per branch
   * (iOS → `xcrun`, Android → `adb`), declare `requires` on each
   * `PlatformImpl` instead — `dispatchByPlatform` will probe only the
   * resolved branch's deps after `classifyDevice`.
   */
  requires?: ToolDependency[];
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

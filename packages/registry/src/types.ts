import { TypedEventEmitter } from './event-emitter';
import { z } from 'zod';

// ── Service Types ──

export enum ServiceState {
  IDLE = 'IDLE',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  TERMINATING = 'TERMINATING',
  ERROR = 'ERROR',
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
export type ServiceRef =
  | string
  | { urn: string; options?: Record<string, unknown> };

/** Options passed to tool execution (e.g. AbortSignal for request cancellation). */
export interface InvokeToolOptions {
  signal?: AbortSignal;
}

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
  serviceStateChange: (
    serviceId: string,
    from: ServiceState,
    to: ServiceState
  ) => void;
  serviceError: (serviceId: string, error: Error) => void;
  serviceRegistered: (serviceId: string) => void;
  toolRegistered: (toolId: string) => void;
  toolInvoked: (toolId: string) => void;
  toolCompleted: (toolId: string, durationMs: number) => void;
  toolFailed: (toolId: string, error: Error) => void;
};

import { TypedEventEmitter } from "./event-emitter";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts";
import type { FileInputSpec, ResolvedFileInput } from "./file-inputs";

// ── Service Types ──

export enum ServiceState {
  IDLE = "IDLE",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  TERMINATING = "TERMINATING",
  ERROR = "ERROR",
}

/**
 * True when a service node is (or is becoming) a live, disposable process —
 * i.e. there is something real to tear down. ERROR and TERMINATING nodes hold
 * no running instance: a start that threw (e.g. SimulatorServer rejecting a
 * tvOS UDID) leaves an ERROR node behind, and reporting that as "stopped" is
 * misleading. The stop tools use this so `stopped: true` means a server was
 * actually running.
 */
export function isLiveServiceState(state: ServiceState): boolean {
  return state === ServiceState.RUNNING || state === ServiceState.STARTING;
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
  /**
   * Resolution outcome for each declared {@link ToolDefinition.fileInputs}
   * target the caller sent as a file-input wrapper, keyed by target arg name.
   * Populated by the HTTP layer (which resolves wrappers before validation)
   * and forwarded to the tool via {@link ToolContext}. Absent for plain-string
   * args (older clients, direct invocations), so a missing entry means
   * "legacy caller — behave exactly as before the file boundary existed".
   */
  fileInputs?: Record<string, ResolvedFileInput>;
  /** Optional caller-provided id used to correlate outer request metadata. */
  toolInvocationId?: string;
  /**
   * Registers a freshly-minted invocation id against the outer request's
   * telemetry attribution, returning a release fn. Set by the tool-server's HTTP
   * layer (bound to the request's metadata) and forwarded verbatim into
   * {@link ToolContext}. Orchestrator tools (run-sequence, flow-execute,
   * flow-add-step) call it for every sub-tool they dispatch through
   * {@link Registry.invokeTool} so nested invocations inherit attribution
   * instead of being recorded as anonymous; they also pass it back down here so
   * propagation survives arbitrary nesting.
   *
   * The outer request's AI client is inherited unchanged. The platform is
   * re-derived from each sub-tool's own `childArgs` (its `udid` / `device_id` /
   * `avdName`), falling back to the outer request's platform when the sub-tool
   * carries no device arg — an orchestrator like flow-execute has no platform of
   * its own and a single flow can target several devices, so the child's device
   * arg is the only correct platform source. Opaque to the registry — it neither
   * reads nor validates the recorded metadata.
   */
  recordChildInvocation?: (toolInvocationId: string, childArgs?: unknown) => () => void;
}

/**
 * What a tool's `execute` receives as its third argument. The registry builds
 * this for every invocation: it carries the caller's {@link InvokeToolOptions}
 * (e.g. `signal`) plus cross-cutting context the registry owns — currently the
 * {@link ArtifactStore}, so any tool that produces a host file can register it
 * (`ctx.artifacts.register(path)`) without declaring a per-tool service. The
 * registry always populates `artifacts`; it is only ever absent when `execute`
 * is called directly (bypassing `invokeTool`), e.g. in a unit test.
 */
export interface ToolContext extends InvokeToolOptions {
  artifacts: ArtifactStore;
}

// ── Device + Capability Types ──

export type Platform = "ios" | "android" | "ios-remote" | "chromium" | "vega";

export type DeviceKind = "simulator" | "emulator" | "vvd" | "device" | "app" | "unknown";

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
  /**
   * Remote-iOS support, driven via `sim-remote`. Independent matrix from
   * `apple` because remote sims have different host-binary requirements
   * (`sim-remote` instead of `xcrun`) and a different transport stack
   * (MoQ + TCP proxy instead of local WebSocket + Unix sockets).
   */
  appleRemote?: {
    simulator?: boolean;
  };
  android?: {
    emulator?: boolean;
    device?: boolean;
    unknown?: boolean;
  };
  chromium?: {
    app?: boolean;
  };
  vega?: {
    vvd?: boolean;
    device?: boolean;
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
export type ToolDependency = "adb" | "xcrun" | "emulator" | "sim-remote" | "vega";

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
  /**
   * When true, signals that an invocation may legitimately run for a long time
   * (e.g. orchestrators that replay many sub-tools). The MCP adapter disables
   * its per-request fetch timeout for these so long invocations don't get
   * aborted mid-flight.
   */
  longRunning?: boolean;
  /**
   * Gates this tool behind a feature flag (a name in @argent/configuration-core's
   * FLAG_REGISTRY). Enforced in TWO places, both re-checked on every request so
   * `argent enable/disable <flag>` takes effect without restarting the long-lived
   * tool-server: (1) the HTTP layer hides the tool from `GET /tools` and rejects
   * `POST /tools/:name` with 404, and (2) `Registry.invokeTool` rejects it so
   * internal dispatch paths (flows, run-sequence) can't bypass the gate. The tool
   * is still registered; gating happens at invocation, not at registration.
   */
  featureFlag?: string;
  /**
   * Runtime predicate to hide this tool from exposure even when its feature flag
   * (if any) is on. Evaluated at the HTTP edge on every `GET /tools` and
   * `POST /tools/:name` — the same cadence as the feature-flag check — so a tool
   * can appear/disappear with live server state without restarting the
   * long-lived tool-server. Returning true hides the tool (absent from the list,
   * 404 on invocation). Use for tools valid only in one server mode; e.g.
   * `await_user_selection` is hidden while an `argent lens` CLI session owns the
   * preview window, because feedback is relayed into the agent's terminal
   * instead of through a blocking await — so the tool should not be offered at
   * all rather than offered-but-forbidden.
   */
  hideWhen?: () => boolean;
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
  /**
   * Args that name files/directories on the CALLER's machine. Surfaced through
   * `GET /tools` so the client can wrap them for the file boundary, and
   * resolved back to server-readable paths before zod validation. See
   * `file-inputs.ts` for the wire contract and kind semantics.
   */
  fileInputs?: FileInputSpec[];
  /** Returns alias → URN or { urn, options }; registry resolves each and passes alias → API into execute. */
  services: (params: TParams) => Record<string, ServiceRef>;
  execute(services: Record<string, unknown>, params: TParams, ctx?: ToolContext): Promise<TResult>;
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
  toolInvoked: (toolId: string, toolInvocationId: string) => void;
  toolCompleted: (toolId: string, toolInvocationId: string, durationMs: number) => void;
  toolFailed: (toolId: string, toolInvocationId: string, error: Error, durationMs?: number) => void;
};

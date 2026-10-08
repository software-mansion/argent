import { TypedEventEmitter } from "./event-emitter";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts";
import type { FileInputSpec, ResolvedFileInput } from "./file-inputs";
import type { FailureSignal } from "./errors";

export enum ServiceState {
  IDLE = "IDLE",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  TERMINATING = "TERMINATING",
  ERROR = "ERROR",
}

/**
 * True when a node holds (or is acquiring) a real process to tear down. ERROR
 * and TERMINATING nodes hold none — a start that threw (e.g. a tvOS UDID the
 * SimulatorServer blueprint rejects) leaves an ERROR node behind — so the stop
 * tools use this to report `stopped` only for servers that were really running.
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

/** Service instance id, `namespace:payload` (e.g. "SimulatorServer:<udid>"). */
export type URN = string;

/** Template for context-aware service instances; `getDependencies` returns alias → URN. */
export interface ServiceBlueprint<T = unknown, C = unknown> {
  namespace: string;
  getURN(context: C): URN;
  getDependencies?(context: C): Record<string, string>;
  factory(
    deps: Record<string, unknown>,
    context: C,
    options?: Record<string, unknown>
  ): Promise<ServiceInstance<T>>;
  /**
   * Whether an error thrown by a tool that used this instance means the instance
   * is dead. The registry disposes every resolved service that answers `true` and
   * retries the tool once against fresh instances, so a cached instance whose
   * process is alive but no longer serving (e.g. an un-booted simulator's
   * simulator-server) self-heals instead of failing identically forever.
   *
   * Keep it conservative: only errors that prove the request never took effect,
   * so the retry can't double-apply a side effect.
   */
  recoverable?(error: unknown): boolean;
}

export interface ServiceNode<T = unknown> {
  urn: URN;
  blueprint: ServiceBlueprint<T, unknown>;
  state: ServiceState;
  instance: ServiceInstance<T> | null;
  initPromise: Promise<T> | null;
  dependents: Set<string>;
}

/** URN, optionally with options forwarded to the blueprint factory. */
export type ServiceRef = string | { urn: string; options?: Record<string, unknown> };

export interface InvokeToolOptions {
  signal?: AbortSignal;
  /**
   * Resolution outcome for each declared {@link ToolDefinition.fileInputs} target
   * the caller sent as a file-input wrapper, keyed by target arg name. Populated
   * by the HTTP layer, which resolves wrappers before validation. Absent for
   * plain-string args (older clients, direct invocations).
   */
  fileInputs?: Record<string, ResolvedFileInput>;
  /** Correlates this call with outer request metadata; the registry mints one when absent. */
  toolInvocationId?: string;
  /**
   * Registers a freshly-minted invocation id against the outer request's
   * telemetry attribution, returning a release fn. Set by the tool-server's HTTP
   * layer; orchestrators (run-sequence, flow-execute, flow-add-step) call it for
   * every sub-tool they dispatch and pass it back down so attribution survives
   * arbitrary nesting.
   *
   * The AI client is inherited unchanged; the platform is re-derived from the
   * sub-tool's own device arg (`udid` / `device_id` / `devices` / `avdName`) and
   * falls back to the outer request's — an orchestrator has no platform of its
   * own and a single flow can target several devices. Opaque to the registry.
   */
  recordChildInvocation?: (toolInvocationId: string, childArgs?: unknown) => () => void;
  /**
   * Fire-and-forget progress events from a long-running tool (e.g. flow-execute
   * streaming one report per completed step). Set only by transports that can
   * deliver increments — the HTTP layer's NDJSON mode. Tools must never behave
   * differently based on its presence; the return value stays the complete,
   * authoritative result.
   */
  emitProgress?: (event: unknown) => void;
}

/**
 * Third argument to a tool's `execute`: the caller's {@link InvokeToolOptions}
 * plus registry-owned context — the {@link ArtifactStore}, so any tool producing
 * a host file can register it (`ctx.artifacts.register({ hostPath, kind })`)
 * without declaring a per-tool service. Absent only when `execute` is called
 * directly, bypassing `invokeTool` (e.g. in a unit test).
 */
export interface ToolContext extends InvokeToolOptions {
  artifacts: ArtifactStore;
}

export type Platform = "ios" | "android" | "ios-remote" | "chromium" | "vega";

export type DeviceKind = "simulator" | "emulator" | "vvd" | "device" | "app" | "unknown";

/**
 * Universal device handle. Platform-aware tools resolve a `udid` parameter into
 * one and dispatch on it to the right per-platform implementation.
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
 */
export interface ToolCapability {
  apple?: {
    simulator?: boolean;
    device?: boolean;
  };
  /**
   * Remote-iOS support. A matrix separate from `apple` because remote sims need
   * the `sim-remote` binary instead of `xcrun` and a MoQ transport instead of the
   * local WebSocket + HTTP one.
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
  supports?: (device: DeviceInfo) => boolean;
}

/**
 * Host binaries (e.g. `xcrun`, `adb`) that a tool — or one platform branch of a
 * tool — cannot run without. `ToolDefinition.requires` is probed by the HTTP
 * dispatcher before any execution, so it fits only tools that need the binary on
 * *every* invocation regardless of the resolved device; `PlatformImpl.requires`
 * is probed inside `dispatchByPlatform` once the device resolves, so an iOS-only
 * environment never trips an `adb` preflight for a tool that merely *could* run
 * on Android.
 *
 * A missing binary answers 424 Failed Dependency with an install hint the agent
 * can surface verbatim.
 */
export type ToolDependency = "adb" | "xcrun" | "emulator" | "sim-remote" | "vega";

export interface ToolDefinition<TParams = void, TResult = unknown> {
  id: string;
  interaction?: {
    startedMsg?: (context: { params: TParams }) => string;
    completedMsg?: (context: { params: TParams; result: TResult }) => string;
    failedMsg?: (context: {
      params: TParams;
      error: unknown;
      failureSignal: FailureSignal;
    }) => string;
  };
  description?: string;
  /** Runtime input validation; `inputSchema` is derived from it at registration. */
  zodSchema?: z.ZodObject<any>;
  /**
   * JSON Schema advertised by `GET /tools`. Derived from `zodSchema` and should
   * never need setting by hand: a hand-written top-level `oneOf`/`allOf`/`anyOf`
   * reached clients once (#773), and the Anthropic Messages API rejects those
   * with a 400 that fails the WHOLE request, every tool in it. Express a
   * cross-field rule as a zod `.refine()`/`.superRefine()` plus a sentence in
   * `description` instead; combinators nested inside `properties` (e.g. a
   * `z.union` field) are fine.
   * Enforced by tool-server/test/tool-input-schema-contract.test.ts.
   */
  inputSchema?: Record<string, unknown>;
  /** Hint for adapters (e.g. "image" makes MCP return base64 image content). */
  outputHint?: string;
  /**
   * Sets `_meta["anthropic/alwaysLoad"]` in the MCP adapter, opting the tool out
   * of Claude Code's progressive tool loading (ToolSearch). For the handful of
   * tools the model needs on every turn.
   */
  alwaysLoad?: boolean;
  /**
   * Short phrase forwarded as `_meta["anthropic/searchHint"]`, so Claude Code's
   * ToolSearch BM25 ranker surfaces the tool without its full description in
   * context.
   */
  searchHint?: string;
  /**
   * Marks invocations that may legitimately run for a long time (e.g.
   * orchestrators replaying many sub-tools): the MCP adapter drops its
   * per-request fetch timeout, and the HTTP layer keeps the idle-shutdown timer
   * warm for the call's duration.
   */
  longRunning?: boolean;
  /**
   * Gates this tool behind a flag name in @argent/configuration-core's
   * FLAG_REGISTRY. Enforced in TWO places, both re-checked per request so
   * `argent enable/disable <flag>` takes effect without restarting the long-lived
   * tool-server: the HTTP layer (hidden from `GET /tools`, 404 from
   * `POST /tools/:name`) and `Registry.invokeTool` (so flows and run-sequence
   * can't bypass the gate). Registration itself is never gated.
   */
  featureFlag?: string;
  /**
   * Hides the tool even when its feature flag is on, re-checked at the HTTP edge
   * on every `GET /tools` and `POST /tools/:name` so exposure tracks live server
   * state (absent from the list, 404 on invocation). For tools valid only in one
   * server mode: `await_user_selection` is hidden while an `argent lens` CLI
   * session owns the preview window, because picks are relayed into the agent's
   * terminal rather than awaited — better not offered than offered-but-forbidden.
   */
  hideWhen?: () => boolean;
  /** Cross-platform tools assert against this before dispatching. */
  capability?: ToolCapability;
  /**
   * Host binaries needed by *every* invocation, probed by the HTTP dispatcher
   * before `execute` runs (424 on a miss). When the requirement differs per
   * branch (iOS → `xcrun`, Android → `adb`), declare it on each `PlatformImpl`
   * instead, so only the resolved branch's deps are probed.
   */
  requires?: ToolDependency[];
  /**
   * Args that name files/directories on the CALLER's machine. Surfaced through
   * `GET /tools` so the client can wrap them for the file boundary, and resolved
   * back to server-readable paths before zod validation. See `file-inputs.ts`
   * for the wire contract and kind semantics.
   */
  fileInputs?: FileInputSpec[];
  /** Alias → URN or { urn, options }; the registry resolves each, passing alias → API to execute */
  services: (params: TParams) => Record<string, ServiceRef>;
  execute(services: Record<string, unknown>, params: TParams, ctx?: ToolContext): Promise<TResult>;
}

export interface ToolRecord {
  definition: ToolDefinition<any, any>;
}

export type RegistryEvents = {
  serviceStateChange: (serviceId: string, from: ServiceState, to: ServiceState) => void;
  serviceError: (serviceId: string, error: Error) => void;
  serviceRegistered: (serviceId: string) => void;
  toolRegistered: (toolId: string) => void;
  toolInvoked: (toolId: string, toolInvocationId: string, msg: string) => void;
  toolCompleted: (
    toolId: string,
    toolInvocationId: string,
    durationMs: number,
    msg: string
  ) => void;
  toolFailed: (
    toolId: string,
    toolInvocationId: string,
    error: Error,
    durationMs: number | undefined,
    msg: string
  ) => void;
};

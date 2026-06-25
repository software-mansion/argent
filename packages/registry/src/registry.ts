import { TypedEventEmitter } from "./event-emitter";
import {
  ServiceState,
  ServiceNode,
  ServiceInstance,
  ServiceBlueprint,
  ToolDefinition,
  ToolRecord,
  RegistryEvents,
  URN,
  InvokeToolOptions,
  ToolContext,
} from "./types";
import { ArtifactStore } from "./artifacts";
import {
  ServiceNotFoundError,
  ServiceInitializationError,
  ToolNotFoundError,
  ToolExecutionError,
} from "./errors";
import { parseURN } from "./urn";
import { zodObjectToJsonSchema } from "./zod-to-json-schema";
import { randomUUID } from "node:crypto";

export class Registry {
  /** Single map: URN -> ServiceNode (all instances). */
  private services = new Map<string, ServiceNode>();
  private blueprints = new Map<string, ServiceBlueprint>();
  private tools = new Map<string, ToolRecord>();
  /**
   * Predicate that decides whether a feature-flagged tool is currently enabled.
   * Injected (rather than importing `@argent/cli` here) so the registry stays
   * free of a CLI dependency. The default treats every flag as enabled, so
   * existing `new Registry()` call sites (tests, non-flag deployments) keep
   * their previous behavior. The tool-server wires the real `isFlagEnabled`.
   */
  private readonly isFlagEnabled: (flag: string) => boolean;
  /**
   * Host files produced by tools, registered during `execute` and served by the
   * `/artifacts/:id` route. Owned here (one per registry/process) so the tool
   * path and the HTTP route resolve the same instance — no module singleton.
   */
  public readonly artifacts = new ArtifactStore();
  public readonly events = new TypedEventEmitter<RegistryEvents>();

  constructor(options: { isFlagEnabled?: (flag: string) => boolean } = {}) {
    this.isFlagEnabled = options.isFlagEnabled ?? (() => true);
  }

  registerBlueprint<T, C>(blueprint: ServiceBlueprint<T, C>): void {
    const { namespace } = blueprint;
    if (this.blueprints.has(namespace)) {
      throw new Error(`Blueprint namespace "${namespace}" already registered`);
    }
    this.blueprints.set(namespace, blueprint as ServiceBlueprint);
  }

  getBlueprint(namespace: string): ServiceBlueprint | undefined {
    return this.blueprints.get(namespace);
  }

  getTool(id: string): ToolDefinition | undefined {
    return this.tools.get(id)?.definition;
  }

  /**
   * Resolve a service by URN. JIT-instantiates from blueprint if not yet created.
   * Optional options are passed to the blueprint's factory (e.g. token for SimulatorServer).
   */
  resolveService<T = unknown>(urn: URN, options?: Record<string, unknown>): Promise<T> {
    return this._resolve<T>(urn, [], options);
  }

  registerTool<TParams = void, TResult = unknown>(
    definition: ToolDefinition<TParams, TResult>
  ): void {
    if (this.tools.has(definition.id)) {
      throw new Error(`Tool "${definition.id}" already registered`);
    }
    // Auto-derive inputSchema from zodSchema if not explicitly provided
    if (definition.zodSchema && !definition.inputSchema) {
      definition.inputSchema = zodObjectToJsonSchema(definition.zodSchema);
    }
    this.tools.set(definition.id, { definition });
    this.events.emit("toolRegistered", definition.id);
  }

  async invokeTool<TResult = unknown>(
    id: string,
    params?: unknown,
    options?: InvokeToolOptions
  ): Promise<TResult> {
    const record = this.tools.get(id);
    if (!record) throw new ToolNotFoundError(id);

    const { definition } = record;

    // Feature-flag gate, enforced for EVERY dispatch path (HTTP, flow-execute,
    // flow-add-step, run-sequence) — not just the HTTP edge. A flag-gated tool
    // whose flag is off is treated as "not found", mirroring the HTTP 404, so a
    // flow can't smuggle an invocation of a disabled tool through the registry.
    if (definition.featureFlag && !this.isFlagEnabled(definition.featureFlag)) {
      throw new ToolNotFoundError(id);
    }

    const startTime = performance.now();
    const toolInvocationId = options?.toolInvocationId ?? randomUUID();
    this.events.emit("toolInvoked", id, toolInvocationId);

    try {
      // Validate params against the tool's zod schema for EVERY dispatch path,
      // not just the HTTP layer. Internal callers (flow-execute, flow-add-step,
      // run-sequence) previously reached `execute` with raw, unvalidated args,
      // which let a flow YAML smuggle a string into a `z.number()` port or
      // shell metacharacters past a tool's regex (→ injection at the sink).
      // `params ?? {}` mirrors the HTTP layer (express.json yields {} for an
      // empty body) so no-arg internal invokes still validate cleanly.
      let effectiveParams = params;
      if (definition.zodSchema) {
        const parsed = definition.zodSchema.safeParse(params ?? {});
        if (!parsed.success) {
          throw new Error(`Invalid params for tool "${id}": ${parsed.error.message}`);
        }
        effectiveParams = parsed.data;
      }

      const aliasToRef = definition.services(effectiveParams);
      const resolvedServices: Record<string, unknown> = {};
      for (const [alias, ref] of Object.entries(aliasToRef)) {
        const urn = typeof ref === "string" ? ref : ref.urn;
        const resolveOptions = typeof ref === "string" ? undefined : ref.options;
        resolvedServices[alias] = await this.resolveService(urn, resolveOptions);
      }

      // Build the per-invocation context: caller options (e.g. signal) plus the
      // registry-owned artifact store, so any tool can register host files via
      // `ctx.artifacts` without declaring a per-tool service.
      const ctx: ToolContext = { ...options, artifacts: this.artifacts };
      const result = await definition.execute(resolvedServices, effectiveParams, ctx);

      const duration = performance.now() - startTime;
      this.events.emit("toolCompleted", id, toolInvocationId, duration);
      return result as TResult;
    } catch (error) {
      const originalMsg = error instanceof Error ? error.message : String(error);

      const wrappedError =
        error instanceof ServiceInitializationError || error instanceof ServiceNotFoundError
          ? new ToolExecutionError(id, `Service dependency failed: ${originalMsg}`, {
              cause: error,
            })
          : new ToolExecutionError(id, originalMsg, {
              cause: error instanceof Error ? error : new Error(String(error)),
            });

      this.events.emit(
        "toolFailed",
        id,
        toolInvocationId,
        wrappedError,
        performance.now() - startTime
      );
      throw wrappedError;
    }
  }

  getServiceState(urn: URN): ServiceState {
    const node = this.services.get(urn);
    if (!node) throw new ServiceNotFoundError(urn);
    return node.state;
  }

  getSnapshot(): {
    services: Map<string, { state: ServiceState; dependents: string[] }>;
    namespaces: string[];
    tools: string[];
  } {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    for (const [urn, node] of this.services) {
      services.set(urn, {
        state: node.state,
        dependents: [...node.dependents],
      });
    }
    return {
      services,
      namespaces: [...this.blueprints.keys()],
      tools: [...this.tools.keys()],
    };
  }

  /**
   * Tear down a single service by URN (and cascade to its dependents).
   * After disposal the service returns to IDLE and can be re-resolved.
   */
  async disposeService(urn: URN): Promise<void> {
    const node = this.services.get(urn);
    if (!node) throw new ServiceNotFoundError(urn);
    await this._teardown(urn);
  }

  async dispose(): Promise<void> {
    for (const [urn, node] of this.services) {
      if (node.state === ServiceState.RUNNING || node.state === ServiceState.STARTING) {
        await this._teardown(urn);
      }
    }
  }

  // ── Private: Resolution ──

  private _resolve<T>(
    urn: URN,
    resolutionPath: string[],
    options?: Record<string, unknown>
  ): Promise<T> {
    let node = this.services.get(urn);
    if (!node) {
      let parsed: { namespace: string; payload: string };
      try {
        parsed = parseURN(urn);
      } catch {
        return Promise.reject(new ServiceNotFoundError(urn));
      }
      const blueprint = this.blueprints.get(parsed.namespace);
      if (!blueprint) {
        return Promise.reject(new ServiceNotFoundError(urn));
      }
      node = {
        urn,
        blueprint: blueprint as ServiceBlueprint<unknown, unknown>,
        state: ServiceState.IDLE,
        instance: null,
        initPromise: null,
        dependents: new Set(),
      };
      this.services.set(urn, node);
    }

    if (resolutionPath.includes(urn)) {
      return Promise.reject(
        new ServiceInitializationError(
          urn,
          `Circular dependency: ${[...resolutionPath, urn].join(" -> ")}`
        )
      );
    }

    if (node.state === ServiceState.TERMINATING) {
      return Promise.reject(
        new ServiceInitializationError(urn, "Service is currently terminating")
      );
    }

    if (node.state === ServiceState.RUNNING && node.instance) {
      return Promise.resolve(node.instance.api as T);
    }

    if (node.state === ServiceState.STARTING && node.initPromise) {
      return node.initPromise as Promise<T>;
    }

    this._transition(node, ServiceState.STARTING);
    const initPromise = this._initialize<T>(node, [...resolutionPath, urn], options);
    node.initPromise = initPromise;
    return initPromise;
  }

  private async _initialize<T>(
    node: ServiceNode,
    resolutionPath: string[],
    options?: Record<string, unknown>
  ): Promise<T> {
    const { urn, blueprint } = node;
    const { payload } = parseURN(urn);
    try {
      const resolvedDeps: Record<string, unknown> = {};
      const depRecord = blueprint.getDependencies ? blueprint.getDependencies(payload) : {};
      for (const [alias, depUrn] of Object.entries(depRecord)) {
        resolvedDeps[alias] = await this._resolve(depUrn, resolutionPath);
        const depNode = this.services.get(depUrn)!;
        depNode.dependents.add(urn);
      }

      const instance = await blueprint.factory(resolvedDeps, payload, options);

      // Guard: if the node was terminated while factory was running, discard the new instance
      if (node.state !== ServiceState.STARTING) {
        try {
          await instance.dispose();
        } catch {
          /* ignore */
        }
        node.initPromise = null;
        throw new ServiceInitializationError(urn, "Service was terminated during initialization");
      }

      this._transition(node, ServiceState.RUNNING);
      node.instance = instance as ServiceInstance;

      instance.events.on("terminated", (error?: Error) => {
        void this._teardown(urn, error);
      });

      return instance.api as T;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this._transition(node, ServiceState.ERROR, cause);
      node.initPromise = null;

      if (error instanceof ServiceInitializationError) {
        throw error;
      }
      throw new ServiceInitializationError(urn, cause.message, { cause });
    }
  }

  private _transition(node: ServiceNode, to: ServiceState, cause?: Error): void {
    const from = node.state;
    node.state = to;
    this.events.emit("serviceStateChange", node.urn, from, to);
    if (to === ServiceState.ERROR) {
      const err = cause
        ? new Error(`Service "${node.urn}" entered ERROR state: ${cause.message}`, { cause })
        : new Error(`Service "${node.urn}" entered ERROR state`);
      this.events.emit("serviceError", node.urn, err);
    }
  }

  private async _teardown(urn: string, cause?: Error): Promise<void> {
    const node = this.services.get(urn);
    if (!node || node.state === ServiceState.IDLE || node.state === ServiceState.TERMINATING)
      return;

    this._transition(node, ServiceState.TERMINATING);

    for (const depUrn of [...node.dependents]) {
      await this._teardown(depUrn, cause);
    }

    if (node.instance) {
      node.instance.events.removeAllListeners();
      try {
        await node.instance.dispose();
      } catch {
        /* logged but not thrown */
      }
    }

    const { payload } = parseURN(urn);
    const depUrns = node.blueprint.getDependencies
      ? Object.values(node.blueprint.getDependencies(payload))
      : [];
    for (const depUrn of depUrns) {
      this.services.get(depUrn)?.dependents.delete(urn);
    }

    node.instance = null;
    node.initPromise = null;
    node.dependents.clear();
    this._transition(node, cause ? ServiceState.ERROR : ServiceState.IDLE, cause);
  }
}

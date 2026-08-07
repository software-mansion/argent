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
  FailureError,
  getFailureSignalOrFallback,
} from "./errors";
import { FAILURE_CODES } from "./failure-codes";
import { parseURN } from "./urn";
import { zodObjectToJsonSchema } from "./zod-to-json-schema";
import { randomUUID } from "node:crypto";
import type { $ZodIssue as ZodIssue } from "zod/v4/core";

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
    let effectiveParams = params;

    const startedMsg = formatInteractionMessage(
      () => definition.interaction?.startedMsg?.({ params: effectiveParams }),
      `Tool ${id} was invoked.`
    );
    this.events.emit("toolInvoked", id, toolInvocationId, startedMsg);

    try {
      // Validate params against the tool's zod schema for EVERY dispatch path,
      // not just the HTTP layer. Internal callers (flow-execute, flow-add-step,
      // run-sequence) previously reached `execute` with raw, unvalidated args,
      // which let a flow YAML smuggle a string into a `z.number()` port or
      // shell metacharacters past a tool's regex (→ injection at the sink).
      // `params ?? {}` mirrors the HTTP layer (express.json yields {} for an
      // empty body) so no-arg internal invokes still validate cleanly.
      if (definition.zodSchema) {
        const parsed = definition.zodSchema.safeParse(params ?? {});
        if (!parsed.success) {
          // A schema miss is a client-input error wherever it is caught. The
          // same rejection can land here or inside a tool (a cross-field rule
          // zod cannot express, a field left optional so an alias is accepted),
          // and telemetry must not read those two as different kinds of
          // failure — an unsignalled Error buckets as ARGENT_UNCLASSIFIED,
          // i.e. as an internal fault the caller could not have avoided.
          throw new FailureError(
            `Invalid params for tool "${id}": ${describeParamIssues(parsed.error, params)}`,
            {
              error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
              failure_stage: "tool_params_parse",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
        effectiveParams = parsed.data;
      }

      // The alias→URN mapping is pure (derived from params), so compute it once
      // up front — we need the URNs to know which services to recover if the
      // tool fails against a dead-but-cached instance.
      const aliasToRef = definition.services(effectiveParams);
      const refs = Object.entries(aliasToRef).map(([alias, ref]) => ({
        alias,
        urn: typeof ref === "string" ? ref : ref.urn,
        options: typeof ref === "string" ? undefined : ref.options,
      }));

      // Build the per-invocation context: caller options (e.g. signal) plus the
      // registry-owned artifact store, so any tool can register host files via
      // `ctx.artifacts` without declaring a per-tool service.
      const ctx: ToolContext = { ...options, artifacts: this.artifacts };

      const runOnce = async (): Promise<TResult> => {
        const resolvedServices: Record<string, unknown> = {};
        for (const { alias, urn, options: resolveOptions } of refs) {
          resolvedServices[alias] = await this.resolveService(urn, resolveOptions);
        }
        return definition.execute(resolvedServices, effectiveParams, ctx) as Promise<TResult>;
      };

      let result: TResult;
      try {
        result = await runOnce();
      } catch (execError) {
        // Self-heal a cached-but-dead service: if any service this tool resolved
        // declares this error recoverable (its underlying process is gone even
        // though the handle was still cached), dispose it and retry the tool
        // once against a freshly re-created instance. Bounded to a single retry
        // so a genuinely broken service can't spin.
        const recovered = await this._recoverFailedServices(refs, execError);
        if (!recovered) throw execError;
        result = await runOnce();
      }

      const duration = performance.now() - startTime;
      const completedMsg = formatInteractionMessage(
        () =>
          definition.interaction?.completedMsg?.({
            params: effectiveParams,
            result,
          }),
        `Tool ${id} completed in ${duration.toFixed(2)} ms.`
      );
      this.events.emit("toolCompleted", id, toolInvocationId, duration, completedMsg);
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
      const failureSignal = getFailureSignalOrFallback(wrappedError);
      const failedMsg = formatInteractionMessage(
        () =>
          definition.interaction?.failedMsg?.({
            params: effectiveParams,
            error: wrappedError,
            failureSignal,
          }),
        `Tool ${id} failed.`
      );

      this.events.emit(
        "toolFailed",
        id,
        toolInvocationId,
        wrappedError,
        performance.now() - startTime,
        failedMsg
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
   * After a tool failed, ask each service it resolved whether the error means
   * that service's instance is dead (`blueprint.recoverable(error)`). Dispose
   * every one that says yes so the next `resolveService` re-creates it, and
   * report whether anything was disposed (i.e. whether a retry is worthwhile).
   *
   * Only currently-RUNNING nodes are considered: a service that already
   * errored/torn down during resolution needs no recovery here, and a URN this
   * tool never resolved must not be touched.
   */
  private async _recoverFailedServices(
    refs: ReadonlyArray<{ urn: URN }>,
    error: unknown
  ): Promise<boolean> {
    let recoveredAny = false;
    for (const { urn } of refs) {
      const node = this.services.get(urn);
      if (!node || node.state !== ServiceState.RUNNING) continue;
      if (node.blueprint.recoverable?.(error) !== true) continue;
      try {
        await this.disposeService(urn);
        recoveredAny = true;
      } catch {
        /* best-effort: if teardown fails, fall through and surface the original error */
      }
    }
    return recoveredAny;
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

/**
 * The value at a Zod issue's `path` within the caller's params, or `undefined`
 * when any segment is absent (or the parent is not indexable). Used to tell an
 * OMITTED field from a present-but-wrong one, without parsing Zod's message.
 */
function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    // Own-property only: a schema field named after an `Object.prototype`
    // member (`toString`, `constructor`, `hasOwnProperty`, …) that the caller
    // OMITTED must read as absent, not as the inherited function — a bare
    // `current[key]` returns that function (`!== undefined`), so the field
    // would be misreported as a type error instead of "is required". Mirrors
    // the `Object.hasOwn` guards the directive lookups already use.
    if (!Object.hasOwn(current as object, key)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/**
 * How many distinct branch reasons a union parameter's message enumerates
 * before it stops and says so. A registered union has a handful of branches, so
 * this is not a limit any well-formed call reaches; it bounds the pathological
 * one, where the branch is an array and the issue count follows the caller's
 * input rather than the schema.
 */
const MAX_UNION_ALTERNATIVES = 12;

/**
 * A schema failure as one sentence per bad parameter, instead of Zod's raw
 * issue JSON.
 *
 * The raw form — `[{"expected":"string","code":"invalid_type","path":["name"]}]`,
 * which is what `flow-start-recording` answers a `flow_name` call with — names
 * the parameter the tool wanted but never the one the caller actually sent, so
 * the reader cannot see that they wrote `flow_name` for `name`. That cost whole
 * turns. Naming the unrecognized keys alongside the missing ones is what makes
 * the mistake self-evident.
 */
export function describeParamIssues(
  error: { issues: readonly ZodIssue[] },
  params: unknown
): string {
  // Key names only, never values: a params object can carry a secret, and this
  // string reaches logs, telemetry and the agent transcript. An array's keys
  // are indices, which say nothing, so skip it.
  const allKeys =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? Object.keys(params as object)
      : [];
  // Cap the echoed list, but SIGNAL the cut with an ellipsis: the "You sent:"
  // list is the only clue to a misspelled key when the schema strips unknowns,
  // and a silent truncation could drop the very key that clue exists to surface.
  const supplied = allKeys.slice(0, 24);
  const truncated = allKeys.length > supplied.length;
  const parts = error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    // A field the caller never supplied reads as a type error unless it is
    // called out as absent, but Zod signals absence differently per field
    // kind: `invalid_type ... received undefined` for a plain type, yet
    // `invalid_value` for an omitted enum/literal, whose message is the
    // misleading "Invalid option: expected one of …" as if a bad value had
    // been SENT. So decide "missing" from the INPUT, not the rendered message:
    // the value at this issue's path being `undefined` is absence whatever the
    // code, which also drops the locale-fragile English-suffix match. A value
    // present-but-wrong (`null`, a number for a string, a bad enum option) is
    // NOT undefined, so it still falls to the per-issue wording below.
    // Nested paths get the same treatment: `steps.0.tool` is every bit as
    // missing as a top-level field.
    // A custom refinement's message is author-written, so it is never rewritten
    // the way the branches below rewrite Zod's own wording — in particular the
    // missing-value branch must not turn it into "`flow_path` is required",
    // naming a field the caller may have omitted quite deliberately. Which is
    // why this arm comes FIRST, ahead of the absence check.
    //
    // The PATH still has to be printed, because two different kinds of rule
    // arrive here. A cross-field rule — "exactly one of name / flow_path",
    // gesture-rotate's radius pair — is about the payload as a whole and
    // anchors at the root, where there is no field to name and the prose is the
    // whole message. A `.refine()` BOUND to a field (`selector.text`'s
    // visible-character rule) anchors at that field, and its message reads as
    // prose about some parameter the sentence does not identify: `await-ui-
    // element` declares both `selector.text` and `expectedText`, so "text must
    // contain at least one visible character" lands ambiguously between them.
    // The raw JSON this replaces carried the path, and "You sent:" only ever
    // reaches the top-level `selector`, so without this the offending sub-key
    // is named nowhere in the message — the exact failure this function exists
    // to remove, on the one issue kind that had opted out of it.
    if (issue.code === "custom") {
      return issue.path.length > 0 ? `\`${at}\`: ${issue.message}` : issue.message;
    }
    if (valueAtPath(params, issue.path) === undefined) {
      const expected = (issue as { expected?: unknown }).expected;
      const kind = typeof expected === "string" ? ` (${expected})` : "";
      return `\`${at}\` is required${kind} and was not provided`;
    }
    if (issue.code === "unrecognized_keys") {
      const keys = (issue as { keys?: readonly string[] }).keys ?? [];
      // Qualify by path, like every other branch. A key nested in `selector`
      // reported as a bare name contradicts the "You sent:" list printed one
      // clause later, which only carries top-level keys — and the hottest
      // instance of this is flow YAML's `id` against the schema's
      // `identifier`, where the reader most needs to see the nesting.
      const at = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
      return `unknown parameter${keys.length === 1 ? "" : "s"} ${keys.map((k) => `\`${at}${k}\``).join(", ")}`;
    }
    // A union's own message is the bare "Invalid input" — everything the caller
    // needs sits in the per-branch issue arrays underneath, which the fallback
    // never reads. That loses the most actionable text a schema produces: the
    // parameter a caller most often gets wrong IS the union one (`tv-remote`'s
    // `button` enumerates 16 legal values, `view-network-logs`' `pageIndex` a
    // number or "latest"), and dropping the enumeration makes the new message
    // strictly worse than the raw JSON it replaced. Render every branch's
    // reason instead, so the alternatives are back on screen.
    if (issue.code === "invalid_union") {
      const branches = (issue as { errors?: readonly (readonly ZodIssue[])[] }).errors ?? [];
      const alternatives: string[] = [];
      // A `Set` for the seen-check, and a hard cap on what is collected. The
      // branch issues are CALLER-sized, not schema-sized: a union whose branch
      // is an array reports one issue per element (`tv-remote`'s `button` takes
      // a list of keys, and zod parses every element before `.max()` fires), so
      // a client can hand this arm an arbitrarily long list. A linear
      // `includes` scan per issue made that quadratic on the request thread,
      // and joining an unbounded list renders megabytes into a message meant to
      // be read. The cap also lets the scan stop early, which is what keeps the
      // work proportional to what is printed rather than to what was sent.
      const seen = new Set<string>();
      let moreAlternatives = false;
      for (const branch of branches) {
        for (const inner of branch) {
          // Inner paths are relative to the union's own path, so qualify them
          // rather than print a bare tail that reads as a top-level key.
          const innerAt = inner.path.length > 0 ? `${at}.${inner.path.join(".")}: ` : "";
          const text = `${innerAt}${inner.message}`;
          // Two branches can fail identically (a union of enums over the same
          // values); saying it twice is noise, not a second alternative.
          if (seen.has(text)) continue;
          if (alternatives.length >= MAX_UNION_ALTERNATIVES) {
            moreAlternatives = true;
            break;
          }
          seen.add(text);
          alternatives.push(text);
        }
        if (moreAlternatives) break;
      }
      if (alternatives.length > 0) {
        // Signal the cut, for the same reason the "You sent:" list does: a
        // silently shortened enumeration reads as the complete set of legal
        // forms, so the caller would rule out the branch they wanted.
        return `\`${at}\`: ${alternatives.join("; or ")}${moreAlternatives ? "; or …" : ""}`;
      }
    }
    return `\`${at}\`: ${issue.message}`;
  });
  const sent =
    supplied.length > 0
      ? ` You sent: ${supplied.map((k) => `\`${k}\``).join(", ")}${truncated ? ", …" : ""}.`
      : "";
  // Guard the (call-site-unreachable, but exported) empty-issues case so it
  // never renders a bare leading ".".
  //
  // Drop a part's own trailing full stop before adding this one. A custom
  // refinement's message survives verbatim and is author-written prose, which
  // normally ends in a period — so every cross-field rule (both flow tools'
  // source-count errors, gesture-scroll, gesture-rotate, await-ui-element)
  // rendered "…/.argent/flows/<name>.yaml.. You sent: …". Only a period is
  // trimmed: a message ending in "?" or "!" keeps its own punctuation.
  const body = parts.length > 0 ? `${parts.map((p) => p.replace(/\.$/, "")).join("; ")}.` : "";
  return `${body}${sent}`.trim() || "invalid parameters";
}

function formatInteractionMessage(format: () => string | undefined, fallback: string): string {
  try {
    return format() ?? fallback;
  } catch {
    return fallback;
  }
}

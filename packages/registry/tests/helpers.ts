import { TypedEventEmitter } from '../src/event-emitter';
import type {
  ServiceBlueprint,
  ServiceEvents,
  ServiceInstance,
  ToolDefinition,
} from '../src/types';

export interface StaticBlueprintResult {
  blueprint: ServiceBlueprint<{ id: string; deps?: string[] }, string>;
  emitters: TypedEventEmitter<ServiceEvents>[];
}

/**
 * Creates a "static" blueprint for a single service id (one instance per URN).
 * Use for tests that previously used registerService: register this blueprint
 * with namespace `static-${id}` and resolve `static-${id}:only`.
 * When the instance is created, its events emitter is pushed to emitters[0].
 */
export function createStaticBlueprint(
  id: string,
  options?: {
    deps?: string[];
    delay?: number;
    failOnInit?: boolean | (() => boolean);
    api?: Record<string, unknown>;
  }
): StaticBlueprintResult {
  const emitters: TypedEventEmitter<ServiceEvents>[] = [];
  const blueprint: ServiceBlueprint<{ id: string; deps?: string[] }, string> = {
    namespace: `static-${id}`,
    getURN() {
      return `static-${id}:only`;
    },
    getDependencies() {
      const deps: Record<string, string> = {};
      for (const d of options?.deps ?? []) {
        deps[d] = `static-${d}:only`;
      }
      return deps;
    },
    async factory(deps, _context, _opts) {
      await new Promise((r) => setTimeout(r, options?.delay ?? 10));
      const shouldFail =
        typeof options?.failOnInit === 'function'
          ? options.failOnInit()
          : options?.failOnInit;
      if (shouldFail) {
        throw new Error(`${id} factory failure`);
      }
      const events = new TypedEventEmitter<ServiceEvents>();
      emitters.push(events);
      return {
        api: options?.api ?? { id, deps: Object.keys(deps) },
        dispose: async () => {},
        events,
      };
    },
  };
  return { blueprint, emitters };
}

/** URN for a static blueprint created with createStaticBlueprint(id). */
export function staticUrn(id: string): string {
  return `static-${id}:only`;
}

/**
 * Creates a mock blueprint for generic URN-based tests (namespace:context).
 */
export function createMockBlueprint(
  namespace: string,
  options?: { dependencies?: (ctx: string) => Record<string, string> }
): ServiceBlueprint<{ id: string; deps?: string[] }, string> {
  return {
    namespace,
    getURN(ctx: string) {
      return `${namespace}:${ctx}`;
    },
    getDependencies: options?.dependencies,
    async factory(deps, context, _opts) {
      const events = new TypedEventEmitter<ServiceEvents>();
      return {
        api: { id: context, deps: Object.keys(deps) },
        dispose: async () => {},
        events,
      };
    },
  };
}

export function createMockToolDef(
  id: string,
  serviceRefs: (params: unknown) => Record<string, string>,
  options?: { fail?: boolean }
): ToolDefinition<unknown, unknown> {
  return {
    id,
    services: serviceRefs,
    async execute(resolvedServices, params) {
      if (options?.fail) {
        throw new Error(`${id} execution failure`);
      }
      return {
        toolId: id,
        receivedServices: Object.keys(resolvedServices),
        params,
      };
    },
  };
}

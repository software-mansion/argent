import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT } from "../../src/utils/react-profiler/scripts";

/**
 * Regression tests for the self-bootstrap path that lets react-profiler-start
 * recover when no external React DevTools client is connected. The script
 * is a self-contained IIFE string evaluated against a mock global hook and
 * Metro module registry — covers each failure mode that maps to a distinct
 * user-facing error in `react-profiler-start.ts`.
 *
 * See `argent-react-profiler-bug.md` (Defect 2) for the motivating bug.
 */

interface BootstrapResult {
  ok: boolean;
  reason: string;
  renderersCount?: number;
  rendererInterfacesCount?: number;
  message?: string;
}

function evalIIFE(script: string): string {
  return (0, eval)(script) as string;
}

interface MockHookOpts {
  noHook?: boolean;
  renderers?: Map<number, unknown>;
  rendererInterfaces?: Map<number, unknown>;
}

interface MockRegistryEntry {
  verboseName?: string;
  module?: Record<string, unknown>;
}

interface ScenarioOpts {
  hook?: MockHookOpts;
  metro?: "map" | "array" | "missing" | "throws";
  registry?: Record<number, MockRegistryEntry>;
  requireThrows?: number[];
}

function runScenario(opts: ScenarioOpts): BootstrapResult {
  const g = globalThis as Record<string, unknown>;
  const originalHook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const originalR = g.__r;

  if (!opts.hook?.noHook) {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: opts.hook?.renderers ?? new Map(),
      rendererInterfaces: opts.hook?.rendererInterfaces ?? new Map(),
    };
  } else {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = undefined;
  }

  if (opts.metro === "missing") {
    g.__r = undefined;
  } else if (opts.metro === "throws") {
    const fn = ((id: number) => {
      if (opts.requireThrows?.includes(id)) throw new Error(`require-${id}-throws`);
      const entry = opts.registry?.[id];
      return entry?.module ?? null;
    }) as ((id: number) => unknown) & { getModules: () => unknown };
    fn.getModules = () => {
      throw new Error("getModules-throws");
    };
    g.__r = fn;
  } else {
    const fn = ((id: number) => {
      if (opts.requireThrows?.includes(id)) throw new Error(`require-${id}-throws`);
      const entry = opts.registry?.[id];
      return entry?.module ?? null;
    }) as ((id: number) => unknown) & { getModules: () => unknown };
    fn.getModules = () => {
      const reg = opts.registry ?? {};
      if (opts.metro === "array") {
        const arr: Array<{ verboseName?: string }> = [];
        for (const [id, entry] of Object.entries(reg)) {
          arr[Number(id)] = { verboseName: entry.verboseName };
        }
        return arr;
      }
      // Default: Map<id, meta>
      const m = new Map<number, { verboseName?: string }>();
      for (const [id, entry] of Object.entries(reg)) {
        m.set(Number(id), { verboseName: entry.verboseName });
      }
      return m;
    };
    g.__r = fn;
  }

  try {
    const json = evalIIFE(BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT);
    return JSON.parse(json) as BootstrapResult;
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = originalHook;
    g.__r = originalR;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT", () => {
  it("returns no-hook when __REACT_DEVTOOLS_GLOBAL_HOOK__ is missing", () => {
    const result = runScenario({ hook: { noHook: true } });
    expect(result).toEqual({ ok: false, reason: "no-hook" });
  });

  it("returns already-attached when rendererInterfaces is non-empty", () => {
    const ri = new Map<number, unknown>([
      [1, { id: 1 }],
      [2, { id: 2 }],
    ]);
    const renderers = new Map<number, unknown>([
      [1, {}],
      [2, {}],
    ]);
    const result = runScenario({ hook: { renderers, rendererInterfaces: ri } });
    expect(result).toMatchObject({
      ok: true,
      reason: "already-attached",
      renderersCount: 2,
      rendererInterfacesCount: 2,
    });
  });

  it("returns no-renderers when React hasn't injected any renderer yet", () => {
    const result = runScenario({
      hook: { renderers: new Map(), rendererInterfaces: new Map() },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "no-renderers",
      renderersCount: 0,
      rendererInterfacesCount: 0,
    });
  });

  it("returns no-metro-modules when __r.getModules is unavailable", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      metro: "missing",
    });
    expect(result).toMatchObject({ ok: false, reason: "no-metro-modules" });
  });

  it("returns no-rdt-module when react-devtools-core is not in the bundle", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      registry: {
        100: { verboseName: "node_modules/react-native/Libraries/Foo.js" },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "no-rdt-module" });
  });

  it("returns unsupported-rdt-version when rdt-core lacks connectWithCustomMessagingProtocol", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      registry: {
        205: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          // Only connectToDevTools — pre-5.1 API surface
          module: { connectToDevTools: () => undefined },
        },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "unsupported-rdt-version" });
  });

  it("returns bootstrapped after a successful connectWithCustomMessagingProtocol call (Map registry)", () => {
    const rendererInterfaces = new Map<number, unknown>();
    const renderers = new Map<number, unknown>([
      [1, {}],
      [2, {}],
    ]);
    const connect = vi.fn(() => {
      // Simulate initBackend populating rendererInterfaces
      rendererInterfaces.set(1, { id: 1 });
      rendererInterfaces.set(2, { id: 2 });
    });
    const result = runScenario({
      hook: { renderers, rendererInterfaces },
      registry: {
        205: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          module: { connectWithCustomMessagingProtocol: connect },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "bootstrapped",
      renderersCount: 2,
      rendererInterfacesCount: 2,
    });
    expect(connect).toHaveBeenCalledOnce();
    const arg = connect.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof arg.onSubscribe).toBe("function");
    expect(typeof arg.onUnsubscribe).toBe("function");
    expect(typeof arg.onMessage).toBe("function");
  });

  it("returns bootstrapped with array-style Metro registry", () => {
    const rendererInterfaces = new Map<number, unknown>();
    const renderers = new Map<number, unknown>([[1, {}]]);
    const connect = vi.fn(() => {
      rendererInterfaces.set(1, { id: 1 });
    });
    const result = runScenario({
      hook: { renderers, rendererInterfaces },
      metro: "array",
      registry: {
        17: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          module: { connectWithCustomMessagingProtocol: connect },
        },
      },
    });
    expect(result).toMatchObject({ ok: true, reason: "bootstrapped" });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("returns metro-scan-error when getModules throws", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      metro: "throws",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("metro-scan-error");
    expect(result.message).toContain("getModules-throws");
  });

  it("returns bootstrap-threw when connectWithCustomMessagingProtocol raises", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      registry: {
        205: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          module: {
            connectWithCustomMessagingProtocol: () => {
              throw new Error("bridge-init-failed");
            },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bootstrap-threw");
    expect(result.message).toContain("bridge-init-failed");
  });

  it("returns bootstrap-no-effect when connectWith… returns without populating interfaces", () => {
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces: new Map() },
      registry: {
        205: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          // No-op: does not populate rendererInterfaces (simulates a broken backend)
          module: { connectWithCustomMessagingProtocol: () => undefined },
        },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "bootstrap-no-effect" });
  });

  it("survives require() throwing for non-matching modules during scan", () => {
    const rendererInterfaces = new Map<number, unknown>();
    const connect = vi.fn(() => {
      rendererInterfaces.set(1, { id: 1 });
    });
    const result = runScenario({
      hook: { renderers: new Map([[1, {}]]), rendererInterfaces },
      registry: {
        100: { verboseName: "node_modules/some-other/lib/index.js" },
        205: {
          verboseName: "node_modules/react-devtools-core/dist/backend.js",
          module: { connectWithCustomMessagingProtocol: connect },
        },
      },
      requireThrows: [100],
    });
    expect(result).toMatchObject({ ok: true, reason: "bootstrapped" });
  });
});

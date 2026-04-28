import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { DISABLE_LOGBOX_SCRIPT } from "../src/utils/debugger/scripts/disable-logbox";

/**
 * The script runs inside the React Native JS runtime via CDP `Runtime.evaluate`.
 * We exercise it in a Node `vm` sandbox with a hand-rolled Metro module registry
 * (`__r`) so we can assert the actual fix for issue #160: `LogBoxData.addException`
 * is monkey-patched so future redbox exceptions (e.g. from
 * `TurboModuleRegistry.getEnforcing('SegmentFetcher')`) are dropped.
 */

interface MockModuleMeta {
  isInitialized: boolean;
  factory: () => unknown;
  exports?: unknown;
}

function makeRequire(modules: Map<number, MockModuleMeta>) {
  function __r(id: number) {
    const meta = modules.get(id);
    if (!meta) throw new Error(`unknown module ${id}`);
    if (!meta.isInitialized) {
      meta.isInitialized = true;
      meta.exports = meta.factory();
    }
    return meta.exports;
  }
  __r.getModules = () =>
    Array.from(modules.entries()).map(
      ([id, meta]) => [id, meta] as [number, MockModuleMeta]
    );
  return __r;
}

function makeLogBoxData() {
  const calls = { addException: 0, addLog: 0, clear: 0 };
  const data = {
    _isDisabled: false,
    addLog() {
      calls.addLog++;
    },
    addException() {
      calls.addException++;
    },
    clear() {
      calls.clear++;
    },
    isMessageIgnored() {
      return false;
    },
    setDisabled(v: boolean) {
      data._isDisabled = v;
    },
  };
  return { data, calls };
}

function makeLogBox(lbData: ReturnType<typeof makeLogBoxData>["data"]) {
  return {
    ignoreAllLogs(value?: boolean) {
      lbData.setDisabled(value !== false);
    },
  };
}

describe("DISABLE_LOGBOX_SCRIPT", () => {
  it("patches addException so future redbox exceptions are dropped (the #160 fix)", () => {
    const { data: lbData, calls } = makeLogBoxData();
    const lb = makeLogBox(lbData);

    const modules = new Map<number, MockModuleMeta>([
      [1, {
        isInitialized: true,
        factory: () => ({ default: lb }),
        exports: { default: lb },
      }],
      [2, {
        isInitialized: true,
        factory: () => lbData,
        exports: lbData,
      }],
    ]);

    const sandbox = vm.createContext({ __r: makeRequire(modules), global: {} });
    vm.runInContext(DISABLE_LOGBOX_SCRIPT, sandbox);

    expect(lbData._isDisabled).toBe(true);
    expect(calls.clear).toBe(1);

    lbData.addException();
    expect(calls.addException).toBe(0);
  });

  it("exits cleanly when __r is unavailable", () => {
    const sandbox = vm.createContext({ global: {} });
    expect(() => vm.runInContext(DISABLE_LOGBOX_SCRIPT, sandbox)).not.toThrow();
  });

  it("falls back to the ErrorUtils-suppressing scan when getModules is missing", () => {
    const { data: lbData, calls } = makeLogBoxData();

    function __r(id: number) {
      if (id === 0) return { default: makeLogBox(lbData) };
      if (id === 1) return lbData;
      throw new Error("missing");
    }
    const globalShim: { ErrorUtils: unknown } = { ErrorUtils: { sentinel: 1 } };
    const sandbox = vm.createContext({ __r, global: globalShim });
    vm.runInContext(DISABLE_LOGBOX_SCRIPT, sandbox);

    expect(lbData._isDisabled).toBe(true);
    expect(calls.clear).toBe(1);
    lbData.addException();
    expect(calls.addException).toBe(0);
    expect(globalShim.ErrorUtils).toEqual({ sentinel: 1 });
  });
});

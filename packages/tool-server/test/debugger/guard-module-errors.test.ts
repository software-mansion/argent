import { afterEach, describe, expect, it, vi } from "vitest";
import { guardModuleLoadErrors } from "../../src/utils/debugger/scripts/guard-module-errors";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";

/**
 * Regression harness for software-mansion/argent#160: reading a lazy export
 * such as `PushNotificationIOS` from `react-native` loads a module whose
 * top-level code throws. Metro's `guardedLoadModule` reports that throw to
 * `ErrorUtils.reportFatalError` (the red box) and returns `undefined`, so every
 * debugger-evaluate call that touched it opened a red box in the app.
 */

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.ErrorUtils;
  delete g.__testRequire;
  delete g.__testLeaked;
});

/** A copy of Metro's guardedLoadModule (metro-runtime/src/polyfills/require.js). */
function installMetroLikeRequire(factory: () => unknown) {
  let inGuard = false;
  g.__testRequire = () => {
    if (!inGuard && g.ErrorUtils) {
      inGuard = true;
      let returnValue;
      try {
        returnValue = factory();
      } catch (e) {
        (g.ErrorUtils as { reportFatalError: (e: unknown) => void }).reportFatalError(e);
      }
      inGuard = false;
      return returnValue;
    }
    return factory();
  };
}

function run(expression: string): unknown {
  return (0, eval)(guardModuleLoadErrors(expression));
}

describe("guardModuleLoadErrors", () => {
  it("throws a module's load error to the caller instead of reporting it as fatal", () => {
    const reportFatalError = vi.fn();
    g.ErrorUtils = { reportFatalError };
    installMetroLikeRequire(() => {
      throw new Error("`new NativeEventEmitter()` requires a non-null argument.");
    });

    // The module returns undefined, so the expression's own error is a TypeError.
    expect(() => run("__testRequire().default")).toThrow(
      "`new NativeEventEmitter()` requires a non-null argument."
    );
    expect(reportFatalError).not.toHaveBeenCalled();
    expect((g.ErrorUtils as { reportFatalError: unknown }).reportFatalError).toBe(reportFatalError);
  });

  it("throws the load error also when the expression catches its own error", () => {
    g.ErrorUtils = { reportFatalError: vi.fn() };
    installMetroLikeRequire(() => {
      throw new Error("load failed");
    });
    expect(() => run("try { __testRequire().x } catch (e) {} 1")).toThrow("load failed");
  });

  it("keeps the expression's value, global scope and own errors", () => {
    const reportFatalError = vi.fn();
    g.ErrorUtils = { reportFatalError };

    expect(run("const a = 2; let b = 3; a * b")).toBe(6);
    expect(run("({ a: 1 })")).toEqual({ a: 1 });
    run("var __testLeaked = 7");
    expect(g.__testLeaked).toBe(7);
    expect(() => run('throw new Error("own")')).toThrow("own");
    expect(() => run("1 +")).toThrow(SyntaxError);
    expect((g.ErrorUtils as { reportFatalError: unknown }).reportFatalError).toBe(reportFatalError);
  });

  it("evaluates unchanged where there is no ErrorUtils", () => {
    expect(run("40 + 2")).toBe(42);
  });

  it("embeds the expression as a string literal", () => {
    g.ErrorUtils = { reportFatalError: vi.fn() };
    expect(run('"})(\\"" + `${1}` + "\\u2028"')).toBe('})("1\u2028');
  });
});

describe("debugger-evaluate", () => {
  function evaluateWith(deviceId: string) {
    const evaluate = vi.fn().mockResolvedValue(1);
    const services = {
      debugger: {
        cdp: { evaluate },
        deviceName: "MockDevice",
        appName: "MockApp",
        logicalDeviceId: undefined,
      } as unknown as JsRuntimeDebuggerApi,
    };
    return debuggerEvaluateTool
      .execute(services, { port: 8081, device_id: deviceId, expression: "1" })
      .then(() => evaluate.mock.calls[0]![0] as string);
  }

  it("guards a Metro runtime's expression", async () => {
    expect(await evaluateWith("405655A7-F5FD-4101-9168-148F0F0953D1")).toBe(
      guardModuleLoadErrors("1")
    );
  });

  it("sends a Chromium app's expression unchanged", async () => {
    expect(await evaluateWith("chromium-cdp-9222")).toBe("1");
  });
});

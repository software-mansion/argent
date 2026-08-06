import { describe, it, expect } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import { reactProfilerSessionBlueprint } from "../../src/blueprints/react-profiler-session";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";
import { STOP_FOR_TAKEOVER_SCRIPT } from "../../src/utils/react-profiler/scripts";

/**
 * What `ReactProfilerSession.dispose()` leaves behind IN THE APP.
 *
 * `react-profiler-stop` was once the only route to a dispose, so dispose could
 * assume the run had already been stopped. Since `ReactProfilerSession` joined
 * `stop-all-simulator-servers`' namespace set that is no longer true: a
 * teardown disposes it mid-run, and an in-app React DevTools backend nobody
 * stopped keeps recording every commit into a buffer only an app or bundle
 * reload frees — outliving the argent session, inside the user's app, while
 * the teardown reports the session as stopped.
 */

interface SentCall {
  method: string;
  params?: Record<string, unknown>;
}

function fakeDebuggerApi(sent: SentCall[]): JsRuntimeDebuggerApi {
  const events = new TypedEventEmitter<Record<string, (...args: never[]) => void>>();
  const cdp = {
    events,
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      return {};
    },
    // The factory's own probes: architecture flags, then the Hermes version.
    evaluate: async (expression: string) => {
      if (expression.includes("RN$Bridgeless")) {
        return JSON.stringify({ bridgeless: true, turboModules: true, fabric: true });
      }
      if (expression.includes("HermesInternal")) {
        return JSON.stringify({ "OSS Release Version": "0.12.0" });
      }
      return undefined;
    },
    isConnected: () => true,
  };
  return {
    port: 8081,
    projectRoot: "/tmp/app",
    deviceName: "iPhone 16 Pro",
    appName: "Bluesky",
    logicalDeviceId: undefined,
    isNewDebugger: true,
    cdp,
  } as unknown as JsRuntimeDebuggerApi;
}

async function makeSession(sent: SentCall[]) {
  return reactProfilerSessionBlueprint.factory(
    { debugger: fakeDebuggerApi(sent) },
    "8081:AAAA-1111",
    undefined
  );
}

describe("ReactProfilerSession dispose", () => {
  it("stops the in-app backend and the Hermes sampler when a run is still active", async () => {
    const sent: SentCall[] = [];
    const instance = await makeSession(sent);
    instance.api.profilingActive = true;
    sent.length = 0;

    await instance.dispose();

    const takeover = sent.find(
      (c) => c.method === "Runtime.evaluate" && c.params?.expression === STOP_FOR_TAKEOVER_SCRIPT
    );
    expect(takeover, "the renderers must be told to stop profiling").toBeDefined();
    expect(sent.map((c) => c.method)).toEqual([
      "Runtime.evaluate",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    // Nothing can reach the session after this, so the flag must not outlive it
    // and read as a run still in progress.
    expect(instance.api.profilingActive).toBe(false);
  });

  it("only disables the domain when the run already ended", async () => {
    // The `react-profiler-stop` path: that tool clears `profilingActive`, sends
    // `Profiler.stop` and runs the stop-and-read script itself. Re-stopping
    // here would send a second `Profiler.stop` against an un-started sampler.
    const sent: SentCall[] = [];
    const instance = await makeSession(sent);
    expect(instance.api.profilingActive).toBe(false);
    sent.length = 0;

    await instance.dispose();

    expect(sent.map((c) => c.method)).toEqual(["Profiler.disable"]);
  });

  it("still disables the domain when the in-app stop throws", async () => {
    const sent: SentCall[] = [];
    const api = fakeDebuggerApi(sent);
    const cdp = api.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const instance = await reactProfilerSessionBlueprint.factory(
      { debugger: api },
      "8081:AAAA-1111",
      undefined
    );
    instance.api.profilingActive = true;
    sent.length = 0;
    cdp.send = async (method: string) => {
      sent.push({ method });
      if (method !== "Profiler.disable") throw new Error("CDP went away mid-teardown");
      return {};
    };

    await expect(instance.dispose()).resolves.toBeUndefined();
    expect(sent.map((c) => c.method)).toEqual([
      "Runtime.evaluate",
      "Profiler.stop",
      "Profiler.disable",
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";
import { debuggerReloadMetroTool } from "../../src/tools/debugger/debugger-reload-metro";

function fakeDebugger(send: () => Promise<unknown>) {
  return {
    port: 8081,
    deviceName: "d",
    appName: "a",
    logicalDeviceId: "l",
    cdp: { send: vi.fn(send), evaluate: vi.fn(async () => undefined) },
  };
}

function run(deviceId: string, api: ReturnType<typeof fakeDebugger>) {
  const params = debuggerReloadMetroTool.zodSchema!.parse({ device_id: deviceId }) as {
    device_id: string;
    port?: number;
  };
  return debuggerReloadMetroTool.execute({ debugger: api } as never, params);
}

describe("debugger-reload-metro when the CDP reload fails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not call Metro's shared /reload for a Mac app", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = fakeDebugger(async () => {
      throw new Error("CDP request timed out");
    });

    const err = await run("macos-app-com.example.app", api).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe("DEBUGGER_RELOAD_FAILED");
    expect((err as Error).message).toContain("CDP request timed out");
    expect(api.cdp.send).toHaveBeenCalledWith("Page.reload");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still falls back to /reload for an iOS simulator", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = fakeDebugger(async () => {
      throw new Error("Page.reload not supported");
    });

    const result = await run("11111111-2222-3333-4444-555555555555", api);

    expect(result.method).toBe("http");
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:8081/reload", { method: "POST" });
  });

  it("reloads a Mac app through CDP when that works", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = fakeDebugger(async () => ({}));

    const result = await run("macos-app-com.example.app", api);

    expect(result.method).toBe("cdp");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

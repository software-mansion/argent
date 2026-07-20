import { describe, it, expect, vi } from "vitest";
import { Registry, ServiceState } from "@argent/registry";
import { createStopSimulatorServerTool } from "../src/tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";
import { stopMetroTool } from "../src/tools/simulator/stop-metro";

function createMockRegistry(services: Map<string, { state: ServiceState; dependents: string[] }>) {
  return {
    getSnapshot: vi.fn(() => ({
      services,
      namespaces: [],
      tools: [],
    })),
    disposeService: vi.fn(async () => {}),
  } as unknown as Registry;
}

describe("stop-simulator-server", () => {
  it("disposes the correct URN for a running simulator", async () => {
    const services = new Map([
      ["SimulatorServer:AAAA-BBBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "AAAA-BBBB" });

    expect(result).toEqual({ stopped: true, udid: "AAAA-BBBB" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAAA-BBBB");
  });

  it("returns stopped: false for a UDID with no running server", async () => {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "CCCC-DDDD" });

    expect(result).toEqual({ stopped: false, udid: "CCCC-DDDD" });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("returns stopped: false for an IDLE simulator", async () => {
    const services = new Map([
      ["SimulatorServer:EEEE-FFFF", { state: ServiceState.IDLE, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "EEEE-FFFF" });

    expect(result).toEqual({ stopped: false, udid: "EEEE-FFFF" });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("returns stopped: false for an ERROR node (e.g. tvOS) but still cleans it up", async () => {
    // A tvOS UDID: the SimulatorServer blueprint throws on start, leaving the
    // node in ERROR. It never ran, so we must not report stopped: true — but we
    // still dispose to clear the dead node.
    const services = new Map([
      ["SimulatorServer:TV-UDID", { state: ServiceState.ERROR, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "TV-UDID" });

    expect(result).toEqual({ stopped: false, udid: "TV-UDID" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TV-UDID");
  });

  it("reports stopped: true for a STARTING simulator", async () => {
    const services = new Map([
      ["SimulatorServer:GGGG-HHHH", { state: ServiceState.STARTING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "GGGG-HHHH" });

    expect(result).toEqual({ stopped: true, udid: "GGGG-HHHH" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:GGGG-HHHH");
  });

  it("stops the live TvControl daemon for a tvOS UDID whose SimulatorServer never ran", async () => {
    // A tvOS UDID (iOS-shaped) holds a live TvControl service that owns the
    // spawned tvos-ax / tvos-hid daemons, while its SimulatorServer node sits in
    // ERROR (the blueprint rejects tvOS). Stopping the device must reap the TV
    // daemon, not just clean up the dead SimulatorServer node.
    const udid = "12345678-1234-1234-1234-123456789012";
    const services = new Map([
      [`SimulatorServer:${udid}`, { state: ServiceState.ERROR, dependents: [] }],
      [`TvControl:${udid}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid });

    expect(result).toEqual({ stopped: true, udid });
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${udid}`);
    expect(registry.disposeService).toHaveBeenCalledWith(`TvControl:${udid}`);
  });

  it("stops the live AndroidTvControl service for an Android TV serial", async () => {
    const serial = "emulator-5554";
    const services = new Map([
      [`AndroidTvControl:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: serial });

    expect(result).toEqual({ stopped: true, udid: serial });
    expect(registry.disposeService).toHaveBeenCalledWith(`AndroidTvControl:${serial}`);
  });

  it("does not target TvControl for a chromium id", async () => {
    const services = new Map([
      ["ChromiumCdp:chromium-cdp-9222", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "chromium-cdp-9222" });

    expect(result).toEqual({ stopped: true, udid: "chromium-cdp-9222" });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith("ChromiumCdp:chromium-cdp-9222");
  });
});

describe("stop-all-simulator-servers", () => {
  it("disposes all running SimulatorServer URNs", async () => {
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
      ["JsRuntimeDebugger:CCC", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, undefined);

    expect(result).toEqual({
      stopped: ["SimulatorServer:AAA", "SimulatorServer:BBB"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAA");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
  });

  it("returns empty list when no simulators are running", async () => {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, undefined);

    expect(result).toEqual({ stopped: [] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("skips IDLE simulators", async () => {
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.IDLE, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, undefined);

    expect(result).toEqual({ stopped: ["SimulatorServer:BBB"] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("disposes an ERROR node (e.g. tvOS) but omits it from the stopped list", async () => {
    const services = new Map([
      ["SimulatorServer:TV-UDID", { state: ServiceState.ERROR, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, undefined);

    // Both get disposed (cleanup), but only the live one is reported as stopped.
    expect(result).toEqual({ stopped: ["SimulatorServer:BBB"] });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TV-UDID");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("stops the focus-driven TV control services (Apple TV + Android TV)", async () => {
    // The TvControl daemon owns the spawned tvos-ax / tvos-hid processes, so a
    // session-end stop must dispose it — not just the simulator-server/CDP nodes.
    const services = new Map([
      ["TvControl:APPLE-TV", { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidTvControl:emulator-5556", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, undefined);

    expect(result).toEqual({
      stopped: ["TvControl:APPLE-TV", "AndroidTvControl:emulator-5556", "SimulatorServer:BBB"],
    });
    expect(registry.disposeService).toHaveBeenCalledWith("TvControl:APPLE-TV");
    expect(registry.disposeService).toHaveBeenCalledWith("AndroidTvControl:emulator-5556");
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
  });
});

describe("stop-metro", () => {
  it("defaults to port 8081", () => {
    expect(stopMetroTool.zodSchema).toBeDefined();
    const parsed = stopMetroTool.zodSchema!.parse({});
    expect(parsed.port).toBe(8081);
  });

  it("accepts a custom port", () => {
    const parsed = stopMetroTool.zodSchema!.parse({ port: 9090 });
    expect(parsed.port).toBe(9090);
  });

  it("returns stopped: false when no process on port", async () => {
    // Use a high port unlikely to have anything listening
    const result = await stopMetroTool.execute!({}, { port: 59999 });
    expect(result.stopped).toBe(false);
    expect(result.port).toBe(59999);
    expect(result.pids).toEqual([]);
  });
});

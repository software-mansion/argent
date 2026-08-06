import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  forgetLogicalKeyedDevice,
  rememberLogicalKeyedDevice,
  resetDeviceAliases,
} from "../src/utils/debugger/device-alias";
import type { z } from "zod";
import { Registry, ServiceState, zodObjectToJsonSchema } from "@argent/registry";
import { createStopSimulatorServerTool } from "../src/tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";
import { stopMetroTool } from "../src/tools/simulator/stop-metro";

function createMockRegistry(services: Map<string, { state: ServiceState; dependents: string[] }>) {
  return {
    // The real `getSnapshot` COPIES each node into a fresh map
    // (Registry.getSnapshot), so a disposal during the sweep cannot rewrite the
    // state the caller is still iterating. Handing over the live map instead
    // would make a cascade retroactively hide its own victim, and the result
    // would depend on the map's insertion order — an artifact of the mock that
    // production does not have.
    getSnapshot: vi.fn(() => ({
      services: new Map(
        [...services].map(([urn, n]) => [urn, { ...n, dependents: [...n.dependents] }])
      ),
      namespaces: [],
      tools: [],
    })),
    // The real `disposeService` returns the node to IDLE and LEAVES IT IN the
    // map (Registry._teardown), rather than removing it — so a second stop of
    // the same device still sees its URNs, in IDLE. Mirror that here: a mock
    // that forgets disposed nodes would hide exactly the sequence the
    // stop-one-then-stop-the-rest tests below exist to pin.
    disposeService: vi.fn(async function dispose(urn: string) {
      const node = services.get(urn);
      if (!node || node.state === ServiceState.IDLE) return;
      // …and it recurses into dependents BEFORE clearing the node
      // (Registry._teardown), so a service whose dependency is disposed goes
      // down with it. Mirror that too, or a test cannot tell a namespace this
      // tool reaps by name from one that merely dies as somebody else's
      // dependent. Mark first, so a dependency cycle cannot recurse forever.
      node.state = ServiceState.IDLE;
      for (const dependent of node.dependents) await dispose(dependent);
    }),
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
      // The negative control has to BE in the map. Without it, "disposed once"
      // is satisfied by the single entry present and the chromium branch could
      // return TvControl too without failing anything.
      ["TvControl:chromium-cdp-9222", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "chromium-cdp-9222" });

    expect(result).toEqual({ stopped: true, udid: "chromium-cdp-9222" });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith("ChromiumCdp:chromium-cdp-9222");
  });

  // Both stop tools resolve "which services does this device own" through the
  // one shared matcher in device-services.ts, so a given udid — whatever its
  // case — reaches the same services through either. Case-insensitivity is the
  // property that matters here: an exact `services.get()` would no-op on a
  // mis-cased udid, leaving a device the caller believes it stopped still
  // running while the scoped stop-all (which folds case) reaps it.

  it("matches a UDID case-insensitively, like the scoped stop-all does", async () => {
    // Agents pass through whatever spelling they were handed, and a case
    // mismatch must not silently turn a scoped stop into a no-op.
    const services = new Map([
      ["SimulatorServer:AAAA-BBBB", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "aaaa-bbbb" });

    expect(result).toEqual({ stopped: true, udid: "aaaa-bbbb" });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAAA-BBBB");
  });

  it("does not let a bare IP claim every wireless-adb device at that address", async () => {
    // An adb serial over wifi is itself `ip:port`, so the shared matcher must
    // compare the whole tail rather than splitting on ":".
    const services = new Map([
      ["SimulatorServer:192.168.1.5:5555", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:192.168.1.5:5557", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: "192.168.1.5" });

    expect(result).toEqual({ stopped: false, udid: "192.168.1.5" });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("leaves this device's devtools and AX services alone", async () => {
    // Deliberately narrower than stop-all: this tool is also the documented
    // recovery for a wedged transport, and dropping native-devtools on a retry
    // would degrade another agent's in-progress recording to coordinate taps.
    //
    // The udid must be a REAL iOS UUID. `classifyDevice` only recognizes the
    // 8-4-4-4-12 hex shape, so a short id like "AAAA-BBBB" classifies as
    // android — and NativeDevtools/AXService, which are iOS-only, would never
    // be candidates for it under any implementation. This test would then pass
    // even if the iOS branch were widened to include them, which is the exact
    // regression it exists to catch.
    const udid = "00000000-0000-0000-0000-0000000000ab";
    const services = new Map([
      [`SimulatorServer:${udid}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${udid}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AXService:${udid}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid });

    expect(result).toEqual({ stopped: true, udid });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${udid}`);
  });

  it("leaves an android device's devtools service alone", async () => {
    // The android twin of the iOS narrowness case above, and the branch the
    // rationale in device-services.ts covers but no prior test did.
    // stop-simulator-server is the wedged-transport recovery, and
    // AndroidDevtools is the tree source an Android recording's selector capture
    // runs on — dropping it on a retry degrades another agent's flow to
    // coordinate taps, exactly what the narrow set exists to prevent. An
    // `emulator-N` serial classifies as android, so widening the android branch
    // to include AndroidDevtools would dispose it here and fail this case.
    const serial = "emulator-5554";
    const services = new Map([
      [`SimulatorServer:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AndroidDevtools:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopSimulatorServerTool(registry);

    const result = await tool.execute!({}, { udid: serial });

    expect(result).toEqual({ stopped: true, udid: serial });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${serial}`);
  });
});

describe("stop-all-simulator-servers", () => {
  it("disposes all running SimulatorServer URNs", async () => {
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:BBB", { state: ServiceState.RUNNING, dependents: [] }],
      // A device-owned namespace like any other: a session that ran
      // debugger-connect against a Chromium app owns it, and the sweep drains
      // it whether or not its transport happens to be in the same snapshot.
      ["ChromiumJsRuntimeDebugger:CCC", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: ["SimulatorServer:AAA", "SimulatorServer:BBB", "ChromiumJsRuntimeDebugger:CCC"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAA");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
  });

  it("leaves a service whose namespace is not device-owned untouched", async () => {
    // The negative control for the unscoped sweep's namespace filter. Every
    // blueprint registered today is device-owned, so nothing real is left out —
    // but `isDeviceServiceUrn` is the only guard between this machine-wide stop
    // (the session-end call every agent makes) and any future non-device
    // service, or a namespace added to the list by mistake. A synthetic
    // out-of-set URN pins that the sweep is namespace-scoped, not "dispose
    // everything": degrade `isDeviceServiceUrn` to `return true` and this fails.
    const services = new Map([
      ["SimulatorServer:AAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["NotADeviceService:global-singleton", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({ stopped: ["SimulatorServer:AAA"] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:AAA");
    expect(registry.disposeService).not.toHaveBeenCalledWith("NotADeviceService:global-singleton");
  });

  // `stopped` is documented as "the services that were actually live and got
  // shut down". ChromiumJsRuntimeDebugger declares `getDependencies ->
  // ChromiumCdp`, so disposing the transport takes it down regardless — while
  // it was outside the namespace set, that shutdown was invisible, and an agent
  // reading `stopped` was not told its console history was gone.
  //
  // Run under both map orders. The registry usually inserts a dependent before
  // its dependency (`_resolve` creates the node, then `_initialize` resolves
  // what it needs), but a session that booted and described before attaching
  // the debugger inserts `ChromiumCdp` first — and since `getSnapshot` copies,
  // the answer must not depend on which happened.
  const CDP = "ChromiumCdp:chromium-cdp-9222";
  const CHROMIUM_DEBUGGER = "ChromiumJsRuntimeDebugger:chromium-cdp-9222";
  const live = () => ({ state: ServiceState.RUNNING, dependents: [] as string[] });
  const cdpWithDependent = () => ({
    state: ServiceState.RUNNING,
    dependents: [CHROMIUM_DEBUGGER],
  });

  it.each([
    ["debugger-connect first (dependent inserted first)", [CHROMIUM_DEBUGGER, CDP]],
    ["boot/describe first (dependency inserted first)", [CDP, CHROMIUM_DEBUGGER]],
  ])(
    "names a chromium debugger in `stopped` whichever order it was inserted — %s",
    async (_label, order) => {
      // Both URNs carry the device id, so each is matched DIRECTLY; the
      // cascade is incidental here and this case is about insertion order not
      // changing membership. What the cascade alone decides is pinned below.
      const services = new Map(
        order.map((urn) => [urn, urn === CDP ? cdpWithDependent() : live()] as const)
      );
      const registry = createMockRegistry(services);
      const tool = createStopAllSimulatorServersTool(registry);

      const result = await tool.execute!({}, { devices: ["chromium-cdp-9222"] });

      // Order follows the snapshot; membership must not.
      expect((result as { stopped: string[] }).stopped.slice().sort()).toEqual(
        [CDP, CHROMIUM_DEBUGGER].sort()
      );
      expect(result).not.toHaveProperty("unmatched");
      expect(services.get(CHROMIUM_DEBUGGER)?.state).toBe(ServiceState.IDLE);
      expect(services.get(CDP)?.state).toBe(ServiceState.IDLE);
    }
  );

  it("takes a non-device dependent down with its dependency without claiming to have reaped it", async () => {
    // The distinction the mock's recursion exists for, and the one the case
    // above cannot make: a dependent this tool does NOT match by device. It
    // still dies — the registry cascades — but it is somebody else's
    // dependent, not something the teardown reaped by name, so it must not
    // appear in `stopped`. Reporting it there would tell an agent a
    // device-scoped teardown deliberately killed its Metro session.
    const METRO = "Metro:8081";
    const services = new Map([
      [CDP, { state: ServiceState.RUNNING, dependents: [METRO] }],
      [METRO, { state: ServiceState.RUNNING, dependents: [] as string[] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["chromium-cdp-9222"] });

    expect(result).toEqual({ stopped: [CDP] });
    expect(services.get(METRO)?.state).toBe(ServiceState.IDLE);
  });

  it("returns empty list when no simulators are running", async () => {
    const services = new Map<string, { state: ServiceState; dependents: string[] }>();
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

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

    const result = await tool.execute!({}, {});

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

    const result = await tool.execute!({}, {});

    // Both get disposed (cleanup), but only the live one is reported as stopped.
    expect(result).toEqual({ stopped: ["SimulatorServer:BBB"] });
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TV-UDID");
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:BBB");
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("reports a STARTING node as stopped and a TERMINATING one as not, in the sweep", async () => {
    // `wasLive` is `isLiveServiceState` — RUNNING or STARTING. The sweep's use
    // of it was only ever exercised for RUNNING and ERROR; STARTING (a server
    // mid-boot, which really is being killed) and TERMINATING (already on its
    // way down, so nothing here stopped it) are the two arms that decide
    // whether a caller is told their device was reaped.
    const services = new Map([
      ["SimulatorServer:STARTING-ONE", { state: ServiceState.STARTING, dependents: [] }],
      ["SimulatorServer:TERMINATING-ONE", { state: ServiceState.TERMINATING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({ stopped: ["SimulatorServer:STARTING-ONE"] });
    // Both are disposed — the point is what gets REPORTED, not what gets cleaned.
    expect(registry.disposeService).toHaveBeenCalledWith("SimulatorServer:TERMINATING-ONE");
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

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: ["TvControl:APPLE-TV", "AndroidTvControl:emulator-5556", "SimulatorServer:BBB"],
    });
    expect(registry.disposeService).toHaveBeenCalledWith("TvControl:APPLE-TV");
    expect(registry.disposeService).toHaveBeenCalledWith("AndroidTvControl:emulator-5556");
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
  });
});

// One tool-server serves every agent using one argent install, so an unscoped
// teardown reaps whatever device another agent is mid-session on. `devices`
// narrows the sweep to the ids the calling session actually used.
const MINE = "AAAA-1111";
const THEIRS = "BBBB-2222";

describe("stop-all-simulator-servers device scoping", () => {
  function twoAgentServices() {
    return new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["ChromiumCdp:chromium-cdp-9222", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
  }

  it("disposes only the named device's URNs and leaves the other device live", async () => {
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`SimulatorServer:${THEIRS}`);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`NativeDevtools:${THEIRS}`);
    expect(registry.disposeService).not.toHaveBeenCalledWith("ChromiumCdp:chromium-cdp-9222");
  });

  it("scopes across platforms when several device ids are named", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidDevtools:emulator-5554", { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "emulator-5554"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, "AndroidDevtools:emulator-5554"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("still disposes everything when no devices are named", async () => {
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: [
        `SimulatorServer:${MINE}`,
        `NativeDevtools:${MINE}`,
        `SimulatorServer:${THEIRS}`,
        `NativeDevtools:${THEIRS}`,
        "ChromiumCdp:chromium-cdp-9222",
      ],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(5);
    // Nothing was requested, so there is nothing that could have missed.
    expect(result).not.toHaveProperty("unmatched");
  });

  it("scopes the non-simulator namespaces too (ChromiumCdp / TvControl / AndroidTvControl)", async () => {
    // Every namespace in DEVICE_OWNED_NAMESPACES must honour `devices`, not just
    // SimulatorServer/NativeDevtools: a TvControl daemon left running holds two
    // spawned --timeout 3600 processes, and reaping another agent's is exactly
    // the cross-session damage scoping exists to prevent.
    const chromium = "chromium-cdp-9222";
    const appleTv = "APPLE-TV-UDID";
    const androidTv = "emulator-5556";
    const services = new Map([
      [`ChromiumCdp:${chromium}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`TvControl:${appleTv}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AndroidTvControl:${androidTv}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`TvControl:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [chromium, appleTv, androidTv] });

    expect(result).toEqual({
      stopped: [`ChromiumCdp:${chromium}`, `TvControl:${appleTv}`, `AndroidTvControl:${androidTv}`],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(3);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`TvControl:${THEIRS}`);
  });

  it("matches a transport-suffixed URN (NativeDevtools:<udid>:tcp)", async () => {
    const services = new Map([
      [`NativeDevtools:${MINE}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${THEIRS}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`NativeDevtools:${MINE}:tcp`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`NativeDevtools:${MINE}:tcp`);
  });

  it("matches a device id that itself contains a colon (wireless adb serial)", async () => {
    const wireless = "192.168.1.5:5555";
    const services = new Map([
      [`AndroidDevtools:${wireless}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [wireless] });

    expect(result).toEqual({ stopped: [`AndroidDevtools:${wireless}`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("does not let a bare IP claim every wireless device at that address", async () => {
    // An adb serial is `ip:port`, so treating "anything after a colon" as the
    // transport discriminator would let a caller who dropped the port tear down
    // a second agent's device — and report nothing unmatched while doing it.
    const services = new Map([
      ["AndroidDevtools:192.168.1.5:5555", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:192.168.1.5:5556", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["192.168.1.5"] });

    expect(result).toEqual({ stopped: [], unmatched: ["192.168.1.5"] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("matches the device id case-insensitively", async () => {
    // iOS UDIDs are conventionally upper-case, but an agent passes through
    // whatever it was handed — a case mismatch must not silently no-op.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE.toLowerCase()}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    // MINE is upper-cased, and the snapshot pairs it against an upper-cased URN
    // (`SimulatorServer:${MINE}`) and a lower-cased one
    // (`NativeDevtools:${MINE.toLowerCase()}:tcp`) — so this exercises
    // upper-id/upper-URN and upper-id/lower-URN. The reverse direction (a
    // lower-cased id against an upper-cased URN) is covered by a separate case
    // below; both must match for a case mismatch never to silently no-op.
    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE.toLowerCase()}:tcp`],
    });
    expect(registry.disposeService).not.toHaveBeenCalledWith(`SimulatorServer:${THEIRS}`);
  });

  it("scopes to nothing for devices: [] rather than sweeping the machine", async () => {
    // A caller that computed a device list and got none must not fall back to
    // tearing down every other agent's services.
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [] });

    expect(result).toEqual({ stopped: [] });
    // No id was requested, so nothing missed: an empty `unmatched` would read
    // as a warning where there is nothing to warn about.
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("rejects a misspelled scope key instead of stripping it into a machine-wide sweep", async () => {
    // `udids` is the natural slip: every sibling tool in this directory spells
    // the device parameter `udid`. Under a stripping schema it left
    // `params.devices` undefined, so the call fell through to the unscoped
    // branch and tore down the other agent's devices while the caller believed
    // it had scoped — and `unmatched` is unreachable on that path, so nothing
    // in the response said otherwise.
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);

    const parsed = tool.zodSchema!.safeParse({ udids: [MINE] });

    expect(parsed.success).toBe(false);
    // The zod parse above is the only gate: MCP, `argent run` and raw HTTP all
    // forward the caller's args verbatim (`argent run` accepts unknown flags on
    // purpose, see flag-parser.ts) and the tool-server parses them with this
    // schema. What the assertion below pins is the ADVERTISED shape, derived
    // from `.strict()` by `zodObjectToJsonSchema` — the schema an agent reads
    // out of `GET /tools` to learn the key is `devices`. An advertised schema
    // still admitting extra keys would document the `udids` typo as legal and
    // leave the rejection looking like a server bug.
    expect(zodObjectToJsonSchema(tool.zodSchema as z.ZodObject<any>)).toMatchObject({
      additionalProperties: false,
    });
  });

  it("drives the scope through its own schema, not just past it", async () => {
    // Every other case here hands `execute` a hand-built params object, so zod
    // is never in the loop and the ONLY schema assertion is a negative (the
    // `udids` rejection above). That leaves the parse itself unpinned: changing
    //
    //   devices: z.array(z.string()).optional()   ->   .default([])
    //
    // typechecks, keeps all 3255 tests green, and makes `params.devices` always
    // `[]` — so `scoped` is permanently true and the machine-wide sweep reaps
    // nothing while answering `{ stopped: [] }`, which the tool documents as
    // "only means nothing was still running". Parse, then execute what the
    // parse produced, on both shapes.
    const registry = createMockRegistry(twoAgentServices());
    const tool = createStopAllSimulatorServersTool(registry);
    const schema = tool.zodSchema!;

    // A scoped call is accepted and reaches execute as the ids it was given.
    expect(schema.safeParse({ devices: [MINE] }).success).toBe(true);
    const scoped = await tool.execute!({}, schema.parse({ devices: [MINE] }));
    expect(scoped).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });

    // And an omitted scope still parses to "absent" — the machine-wide sweep —
    // rather than to an empty list that would scope to nothing.
    const swept = createMockRegistry(twoAgentServices());
    const sweepTool = createStopAllSimulatorServersTool(swept);
    expect(schema.parse({}).devices).toBeUndefined();
    const unscoped = await sweepTool.execute!({}, schema.parse({}));
    expect(unscoped.stopped).toHaveLength(5);
    expect(unscoped).not.toHaveProperty("unmatched");
  });

  it("does not match a device id that is a prefix of another device's id", async () => {
    const services = new Map([
      ["SimulatorServer:AAAA", { state: ServiceState.RUNNING, dependents: [] }],
      ["SimulatorServer:AAAA-EXTRA", { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["AAAA"] });

    expect(result).toEqual({ stopped: ["SimulatorServer:AAAA"] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("skips an IDLE service on the named device", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`NativeDevtools:${MINE}`] });
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });
});

describe("stop-all-simulator-servers unmatched ids", () => {
  // Without `unmatched`, a scoped stop whose ids owned nothing answers with a
  // bare `{ stopped: [] }` — byte-identical to the answer on a genuinely clean
  // machine. A mistyped id, a device *name* passed where an id was expected, or
  // an empty string would all read as success while the services they were
  // meant to reap (on tvOS, two spawned --timeout 3600 daemons) stayed running.
  // `unmatched` names them, so scoping cannot fail silently.

  it("names an unknown id in unmatched while still stopping the live device", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
      unmatched: ["GHOST-9999"],
    });
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("reports a typo, a device name, and an empty-string id — the shapes that would otherwise look clean", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const typo = `${MINE}0`;
    const deviceName = "iPhone 15 Pro";
    const result = await tool.execute!({}, { devices: [MINE, typo, deviceName, ""] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: [typo, deviceName, ""],
    });
  });

  it("omits unmatched entirely when every requested id matched something", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      ["AndroidDevtools:emulator-5554", { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "emulator-5554"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, "AndroidDevtools:emulator-5554"],
    });
    // Absent, not an empty array — a clean scoped stop must carry no warning.
    expect(result).not.toHaveProperty("unmatched");
  });

  it("does not report an all-IDLE device as unmatched — it still owns those nodes", async () => {
    // `disposeService` returns a node to IDLE without removing it, so this is
    // precisely the state a device is left in by a stop THIS session already
    // performed. `unmatched` means "this id owns nothing on the machine, look
    // for a typo"; saying it about a device we just tore down ourselves is a
    // false alarm on the routine stop-one-then-stop-the-rest sequence.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.IDLE, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999"] });

    // Nothing left to stop for MINE, but only the id that owns no node at all
    // is a miss.
    expect(result).toEqual({ stopped: [], unmatched: ["GHOST-9999"] });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("reports nothing unmatched when the same device is stopped twice in a row", async () => {
    // The session-end sequence the argent rules prescribe: stop the device you
    // finished with, then sweep the rest. The second call finds every URN the
    // first one left behind in IDLE, and must not read that as a mistyped id.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const first = await tool.execute!({}, { devices: [MINE] });
    expect(first).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });
    expect(first).not.toHaveProperty("unmatched");

    const second = await tool.execute!({}, { devices: [MINE] });
    expect(second).toEqual({ stopped: [] });
    expect(second).not.toHaveProperty("unmatched");
    // The second call had nothing live to tear down.
    expect(registry.disposeService).toHaveBeenCalledTimes(2);
  });

  it("stops AXService and does not call a describe-only iOS session a typo", async () => {
    // An iOS session that only ran boot/launch/describe owns `AXService:<udid>`
    // — and also `NativeDevtools:<udid>`, which bootIos and launch-app resolve
    // unconditionally (omitted from this snapshot to isolate the AXService
    // case). `AXService` is a device-owned namespace holding the in-sim ax
    // daemon (spawned --timeout 3600), so a scoped stop reaps it AND does not
    // report the correct UDID as unmatched: it owns a real service, not a typo.
    const services = new Map([
      [`AXService:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`AXService:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).toHaveBeenCalledWith(`AXService:${MINE}`);
  });

  it("scopes the tcp-transport AXService URN to its own device", async () => {
    // `axServiceRef(device, { transport: "tcp" })` appends `:tcp`, exactly as
    // `nativeDevtoolsRef` does. No call site passes that option today — the
    // remote host's forced-TCP decision happens inside the factory, after the
    // ref has fixed the URN — so this is a shape the ref can mint rather than
    // one production currently produces, and the coverage is defensive: the
    // matcher must not start splitting a device id on ":" if one ever does.
    const services = new Map([
      [`AXService:${MINE}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AXService:${THEIRS}:tcp`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`AXService:${MINE}:tcp`] });
    expect(registry.disposeService).not.toHaveBeenCalledWith(`AXService:${THEIRS}:tcp`);
  });

  it("owns and stops a device whose only service is a screen recording", async () => {
    // ScreenRecordingSession holds an ffmpeg child, an MJPEG frame stream and
    // the touch-visualizer overlay it enabled on the device, and nothing
    // cascades to it. It is a device-owned namespace, so a session that ran
    // screen-recording-start is correctly reaped by a scoped stop and its
    // serial is not reported as a mistyped id.
    const services = new Map([
      [`ScreenRecordingSession:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`ScreenRecordingSession:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
  });

  it("owns and stops a device whose only service is a native profiler session", async () => {
    // Same shape: an xctrace child on iOS, an on-device perfetto process plus
    // its trace file on Android.
    const services = new Map([
      [`NativeProfilerSession:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`NativeProfilerSession:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
  });

  it("scopes the port-keyed debugger URNs to the right device", async () => {
    // JsRuntimeDebugger's URN interposes the Metro port: `<ns>:<port>:<id>`.
    // Matched as `<ns>:<id>` it would belong to nobody, so a debugger-only
    // session's serial would read as unmatched while its bound port and Metro
    // CDP socket stayed open — the port-keyed match is what prevents that. Both
    // devices sit behind the SAME port, so this also pins that the port is not
    // what the scoping keys on.
    const services = new Map([
      [`JsRuntimeDebugger:8081:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`JsRuntimeDebugger:8081:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).not.toHaveBeenCalledWith(`JsRuntimeDebugger:8081:${THEIRS}`);
  });

  it("does not let a port-keyed URN's port be mistaken for a wireless-adb device id", async () => {
    // The device id after the port can itself be `ip:port`. Only the FIRST
    // colon is the Metro port, so the remainder must be compared whole.
    const serial = "192.168.1.5:5555";
    const services = new Map([
      [`JsRuntimeDebugger:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    expect(await tool.execute!({}, { devices: [serial] })).toEqual({
      stopped: [`JsRuntimeDebugger:8081:${serial}`],
    });

    // A bare IP must not claim it, and neither must the port.
    const registry2 = createMockRegistry(
      new Map([
        [`JsRuntimeDebugger:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
      ])
    );
    const tool2 = createStopAllSimulatorServersTool(registry2);
    expect(await tool2.execute!({}, { devices: ["192.168.1.5", "8081"] })).toEqual({
      stopped: [],
      unmatched: ["192.168.1.5", "8081"],
    });
  });

  it("scopes the port-keyed NetworkInspector and ReactProfilerSession URNs to the right device", async () => {
    // NetworkInspector and ReactProfilerSession share JsRuntimeDebugger's
    // port-keyed URN shape (`<ns>:<port>:<deviceId>`) but are declared apart
    // from it in PORT_KEYED_NAMESPACES. Without that membership neither
    // namespace is in DEVICE_OWNED_NAMESPACES at all, so a standalone node
    // (no JsRuntimeDebugger present to cascade through) would match nothing
    // and never be named in `stopped`. Both devices sit behind the SAME port,
    // so this also pins that the port is not what the scoping keys on.
    const services = new Map([
      [`NetworkInspector:8081:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NetworkInspector:8081:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`ReactProfilerSession:8081:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`ReactProfilerSession:8081:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`NetworkInspector:8081:${MINE}`, `ReactProfilerSession:8081:${MINE}`],
    });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).not.toHaveBeenCalledWith(`NetworkInspector:8081:${THEIRS}`);
    expect(registry.disposeService).not.toHaveBeenCalledWith(`ReactProfilerSession:8081:${THEIRS}`);
  });

  it("does not let a NetworkInspector/ReactProfilerSession port be mistaken for a wireless-adb device id", async () => {
    // Mirrors the JsRuntimeDebugger case above: the device id after the port
    // can itself be `ip:port`, so only the FIRST colon may be consumed as the
    // Metro port.
    const serial = "192.168.1.5:5555";
    const services = new Map([
      [`NetworkInspector:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`ReactProfilerSession:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    expect(await tool.execute!({}, { devices: [serial] })).toEqual({
      stopped: [`NetworkInspector:8081:${serial}`, `ReactProfilerSession:8081:${serial}`],
    });

    // A bare IP must not claim it, and neither must the port.
    const registry2 = createMockRegistry(
      new Map([
        [`NetworkInspector:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
        [`ReactProfilerSession:8081:${serial}`, { state: ServiceState.RUNNING, dependents: [] }],
      ])
    );
    const tool2 = createStopAllSimulatorServersTool(registry2);
    expect(await tool2.execute!({}, { devices: ["192.168.1.5", "8081"] })).toEqual({
      stopped: [],
      unmatched: ["192.168.1.5", "8081"],
    });
  });

  it("reaps AXService on an unscoped machine-wide sweep too", async () => {
    const services = new Map([
      [`AXService:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, {});

    expect(result).toEqual({
      stopped: [`AXService:${MINE}`, `SimulatorServer:${THEIRS}`],
    });
  });

  it("names a repeated missing id only once", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    // A device list assembled from several sources can repeat an id; the
    // warning is about the id, not about how many times it was passed.
    const result = await tool.execute!({}, { devices: [MINE, "GHOST-9999", MINE, "GHOST-9999"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: ["GHOST-9999"],
    });
  });

  it("names a repeated missing id only once across CASE variants too", async () => {
    // The de-duplication lowercases, matching the lookup — but every case above
    // repeats an id in one spelling, so mutating `seen` to identity kept the
    // whole stop-tool suite green. Two spellings of one wrong id are one
    // mistake, and it is reported in the caller's FIRST spelling.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: ["GHOST-9999", "ghost-9999"] });

    expect(result).toEqual({ stopped: [], unmatched: ["GHOST-9999"] });
  });

  it("reports neither spelling when one device is named twice in different cases", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    // Matching is case-insensitive, so both spellings name the same device —
    // and the device matched. Neither is a miss.
    const result = await tool.execute!({}, { devices: [MINE, MINE.toLowerCase()] });

    expect(result).toEqual({ stopped: [`SimulatorServer:${MINE}`] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).toHaveBeenCalledOnce();
  });

  it("does not report an ERROR-only device as unmatched — its dead node was cleaned up", async () => {
    // The other side of the IDLE case above: neither state is a miss (both own
    // nodes), but an ERROR node is still DISPOSED — it never ran, so it never
    // shows up in `stopped`, yet the dead node has to be cleared.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.ERROR, dependents: [] }],
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.IDLE, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, THEIRS] });

    expect(result).toEqual({ stopped: [] });
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).toHaveBeenCalledOnce();
    expect(registry.disposeService).toHaveBeenCalledWith(`SimulatorServer:${MINE}`);
  });

  it("counts a case-differing id as matched and echoes the caller's own spelling for the miss", async () => {
    // The registry holds the upper-case UDID; the caller passes lower-case.
    // The hit must not be reported as a miss (matching is case-insensitive),
    // and the miss must come back spelled exactly as the caller typed it so the
    // agent can find it in its own device list.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE.toLowerCase(), "Mine-Typo"] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`],
      unmatched: ["Mine-Typo"],
    });
  });
});

describe("stop-all-simulator-servers abort", () => {
  // A sweep is a loop of awaited disposals across thirteen namespaces, each
  // reaping spawned processes and sockets. Ignoring the request signal billed a
  // caller who had already given up — an MCP client timing out, a cancelled CLI
  // run — for the whole of it.

  it("stops sweeping once the request is aborted, and says the teardown is partial", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`AXService:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const controller = new AbortController();
    // Abort as soon as the first disposal has happened.
    vi.mocked(registry.disposeService).mockImplementationOnce(async (urn: string) => {
      services.get(urn)!.state = ServiceState.IDLE;
      controller.abort();
    });
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] }, {
      signal: controller.signal,
    } as never);

    expect(result).toEqual({ stopped: [`SimulatorServer:${MINE}`], aborted: true });
    expect(registry.disposeService).toHaveBeenCalledTimes(1);
  });

  it("does not report `unmatched` for a partial sweep it never finished reading", async () => {
    // The id may well own a service further down the snapshot, so calling it a
    // typo here would be a guess — and `left_running` would name every
    // namespace past the break.
    const services = new Map([
      [`SimulatorServer:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const controller = new AbortController();
    controller.abort();
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] }, {
      signal: controller.signal,
    } as never);

    expect(result).toEqual({ stopped: [], aborted: true });
    expect(registry.disposeService).not.toHaveBeenCalled();
  });

  it("sweeps to completion when no signal is supplied", async () => {
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`NativeDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`SimulatorServer:${MINE}`, `NativeDevtools:${MINE}`],
    });
  });
});

describe("stop-all-simulator-servers left_running", () => {
  // With two or more devices on one Metro, `debugger-connect` refuses a udid /
  // serial and instructs the caller to re-target with the `logicalDeviceId`
  // Metro echoed. That id keys the session's URN, and no `list-devices` id
  // equals it — so no `devices` scope can reap the CDP socket, the bound
  // loopback console server or the log file handle it holds. Worse, the
  // caller's real serial DOES match that device's other services, so it never
  // lands in `unmatched` and the teardown reads as a clean machine.
  const LOGICAL = "b5f2c1e0-7a44-4d8e-9c31-metro-logical";

  // What the JsRuntimeDebugger factory records when the id it was resolved with
  // IS the logicalDeviceId Metro echoed — the one place both ids are compared.
  beforeEach(() => {
    resetDeviceAliases();
    rememberLogicalKeyedDevice(LOGICAL, LOGICAL);
  });
  afterEach(() => resetDeviceAliases());

  it("names a logicalDeviceId-keyed debugger session the scope could not reach", async () => {
    const services = new Map([
      [`AndroidDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({
      stopped: [`AndroidDevtools:${MINE}`],
      left_running: [`JsRuntimeDebugger:8081:${LOGICAL}`],
    });
    // The serial matched a service, so it is not a typo — the point is that
    // `unmatched` cannot be the thing that reports this.
    expect(result).not.toHaveProperty("unmatched");
    expect(registry.disposeService).not.toHaveBeenCalledWith(`JsRuntimeDebugger:8081:${LOGICAL}`);
  });

  it("names the network inspector and React profiler riding on that session too", async () => {
    const services = new Map([
      [`AndroidDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [
        `JsRuntimeDebugger:8081:${LOGICAL}`,
        {
          state: ServiceState.RUNNING,
          dependents: [`NetworkInspector:8081:${LOGICAL}`, `ReactProfilerSession:8081:${LOGICAL}`],
        },
      ],
      [`NetworkInspector:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`ReactProfilerSession:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result.left_running).toEqual([
      `JsRuntimeDebugger:8081:${LOGICAL}`,
      `NetworkInspector:8081:${LOGICAL}`,
      `ReactProfilerSession:8081:${LOGICAL}`,
    ]);
  });

  it("reaps rather than reports the session once the logicalDeviceId is supplied", async () => {
    // The documented recovery, and the proof the id is the whole gap: pass it
    // alongside the serial and the session is stopped like anything else.
    const services = new Map([
      [`AndroidDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const registry = createMockRegistry(services);
    const tool = createStopAllSimulatorServersTool(registry);

    const result = await tool.execute!({}, { devices: [MINE, LOGICAL] });

    expect(result).toEqual({
      stopped: [`AndroidDevtools:${MINE}`, `JsRuntimeDebugger:8081:${LOGICAL}`],
    });
    expect(result).not.toHaveProperty("left_running");
  });

  it("stays silent about another agent's serial-keyed session", async () => {
    // `THEIRS` connected by serial (one device on that Metro), so it is an id
    // `list-devices` hands out and a scope COULD have named it. A session left
    // on it is that agent's business, not a scope that cannot express itself —
    // reporting it would invite exactly the cross-agent teardown the `devices`
    // scope exists to prevent.
    const services = new Map([
      [`SimulatorServer:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${THEIRS}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`SimulatorServer:${MINE}`] });
  });

  it("stops reporting the session once its debugger connection is disposed", async () => {
    // The marker is dropped in the blueprint's dispose alongside the alias, so a
    // stale one cannot make a later teardown accuse a session that is gone.
    forgetLogicalKeyedDevice(LOGICAL);
    const services = new Map([
      [`AndroidDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    expect(await tool.execute!({}, { devices: [MINE] })).toEqual({
      stopped: [`AndroidDevtools:${MINE}`],
    });
  });

  it("reports nothing on an unscoped sweep, which reaps every namespace anyway", async () => {
    const services = new Map([
      [`JsRuntimeDebugger:8081:${LOGICAL}`, { state: ServiceState.RUNNING, dependents: [] }],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    const result = await tool.execute!({}, {});

    expect(result).toEqual({ stopped: [`JsRuntimeDebugger:8081:${LOGICAL}`] });
  });

  it("ignores an IDLE session, which holds nothing left to leave running", async () => {
    const services = new Map([
      [`AndroidDevtools:${MINE}`, { state: ServiceState.RUNNING, dependents: [] }],
      [`JsRuntimeDebugger:8081:${LOGICAL}`, { state: ServiceState.IDLE, dependents: [] }],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    const result = await tool.execute!({}, { devices: [MINE] });

    expect(result).toEqual({ stopped: [`AndroidDevtools:${MINE}`] });
  });

  it("matches the marker case-insensitively, as every other id comparison here does", async () => {
    const services = new Map([
      [
        `JsRuntimeDebugger:8081:${LOGICAL.toUpperCase()}`,
        { state: ServiceState.RUNNING, dependents: [] },
      ],
    ]);
    const tool = createStopAllSimulatorServersTool(createMockRegistry(services));

    expect(await tool.execute!({}, { devices: [MINE] })).toEqual({
      stopped: [],
      unmatched: [MINE],
      left_running: [`JsRuntimeDebugger:8081:${LOGICAL.toUpperCase()}`],
    });
  });
});

describe("stop-all-simulator-servers interaction messages", () => {
  // Both formatters previously had no coverage at all — flattening either to
  // an unconditional string left the whole suite green. Pin the exact wording
  // for every branch a caller can hit.
  function tool() {
    return createStopAllSimulatorServersTool(createMockRegistry(new Map()));
  }

  it("startedMsg reports a machine-wide sweep when devices is omitted", () => {
    const startedMsg = tool().interaction!.startedMsg!;
    expect(startedMsg({ params: {} })).toBe("Stopping all simulator servers");
  });

  it("startedMsg is singular for exactly one device", () => {
    const startedMsg = tool().interaction!.startedMsg!;
    expect(startedMsg({ params: { devices: [MINE] } })).toBe(
      "Stopping simulator servers for 1 device"
    );
  });

  it("startedMsg is plural for two or more devices", () => {
    const startedMsg = tool().interaction!.startedMsg!;
    expect(startedMsg({ params: { devices: [MINE, THEIRS] } })).toBe(
      "Stopping simulator servers for 2 devices"
    );
  });

  it("completedMsg has no unmatched clause when nothing was unmatched, singular and zero counts", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(completedMsg({ params: {}, result: { stopped: [`SimulatorServer:${MINE}`] } })).toBe(
      "Stopped 1 simulator server"
    );
    expect(completedMsg({ params: {}, result: { stopped: [] } })).toBe(
      "Stopped 0 simulator servers"
    );
  });

  it("completedMsg pluralizes 'servers' for more than one stopped", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(
      completedMsg({
        params: {},
        result: { stopped: [`SimulatorServer:${MINE}`, `SimulatorServer:${THEIRS}`] },
      })
    ).toBe("Stopped 2 simulator servers");
  });

  it("completedMsg appends the singular unmatched clause for exactly one bad id", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(
      completedMsg({
        params: { devices: [MINE, "GHOST-9999"] },
        result: { stopped: [`SimulatorServer:${MINE}`], unmatched: ["GHOST-9999"] },
      })
    ).toBe("Stopped 1 simulator server (1 supplied id matched no service)");
  });

  it("completedMsg appends the plural unmatched clause for two or more bad ids", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(
      completedMsg({
        params: { devices: ["GHOST-1", "GHOST-2"] },
        result: { stopped: [], unmatched: ["GHOST-1", "GHOST-2"] },
      })
    ).toBe("Stopped 0 simulator servers (2 supplied ids matched no service)");
  });

  it("completedMsg appends the left_running clause, singular and plural", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(
      completedMsg({
        params: { devices: [MINE] },
        result: {
          stopped: [`SimulatorServer:${MINE}`],
          left_running: ["JsRuntimeDebugger:8081:L"],
        },
      })
    ).toBe("Stopped 1 simulator server (1 debugger session left running)");
    expect(
      completedMsg({
        params: { devices: [MINE] },
        result: {
          stopped: [],
          left_running: ["JsRuntimeDebugger:8081:L", "NetworkInspector:8081:L"],
        },
      })
    ).toBe("Stopped 0 simulator servers (2 debugger sessions left running)");
  });

  it("completedMsg reports both clauses when a call hits both", () => {
    const completedMsg = tool().interaction!.completedMsg!;
    expect(
      completedMsg({
        params: { devices: ["GHOST-1"] },
        result: { stopped: [], unmatched: ["GHOST-1"], left_running: ["JsRuntimeDebugger:8081:L"] },
      })
    ).toBe(
      "Stopped 0 simulator servers (1 supplied id matched no service; 1 debugger session left running)"
    );
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

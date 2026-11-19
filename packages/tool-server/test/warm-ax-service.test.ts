import { describe, expect, it, vi } from "vitest";
import { Registry, ServiceState, TypedEventEmitter, type ServiceInstance } from "@argent/registry";
import { AX_SERVICE_NAMESPACE } from "../src/blueprints/ax-service";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../src/blueprints/native-devtools";
import { SIMULATOR_SERVER_NAMESPACE } from "../src/blueprints/simulator-server";
import { warmAxServiceOnSimulatorStart } from "../src/utils/warm-ax-service";

const SIMULATOR_UDID = "AB12CD34-1111-2222-3333-444455556666";

function stubInstance(): ServiceInstance<object> {
  return { api: {}, dispose: async () => {}, events: new TypedEventEmitter() };
}

type StubFactory = (
  deps: unknown,
  payload: unknown,
  options?: Record<string, unknown>
) => Promise<ServiceInstance<object>>;

function stubBlueprint(namespace: string, factory: StubFactory) {
  return { namespace, getURN: (id: string) => `${namespace}:${id}`, factory };
}

function createWarmingRegistry(axFactory: StubFactory, simulatorServerFactory?: StubFactory) {
  const registry = new Registry();
  registry.registerBlueprint(
    stubBlueprint(
      SIMULATOR_SERVER_NAMESPACE,
      simulatorServerFactory ?? (async () => stubInstance())
    )
  );
  registry.registerBlueprint(stubBlueprint(NATIVE_DEVTOOLS_NAMESPACE, async () => stubInstance()));
  registry.registerBlueprint(stubBlueprint(AX_SERVICE_NAMESPACE, axFactory));
  warmAxServiceOnSimulatorStart(registry);
  return registry;
}

function stateOf(registry: Registry, urn: string) {
  return registry.getSnapshot().services.get(urn)?.state;
}

async function startService(registry: Registry, urn: string) {
  await registry.resolveService(urn).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
}

async function startSimulatorServer(registry: Registry, deviceId: string) {
  await startService(registry, `${SIMULATOR_SERVER_NAMESPACE}:${deviceId}`);
}

async function failToStart(): Promise<ServiceInstance<object>> {
  throw new Error("failed to start");
}

describe("warmAxServiceOnSimulatorStart", () => {
  it("starts the ax-service once when a local iOS simulator's simulator-server comes up", async () => {
    const axFactory = vi.fn<StubFactory>(async () => stubInstance());
    const registry = createWarmingRegistry(axFactory);

    await startSimulatorServer(registry, SIMULATOR_UDID);
    await startSimulatorServer(registry, SIMULATOR_UDID);

    expect(axFactory).toHaveBeenCalledTimes(1);
    expect(axFactory.mock.calls[0]?.[2]).toMatchObject({
      device: { id: SIMULATOR_UDID, platform: "ios", kind: "simulator" },
    });
    expect(stateOf(registry, `${AX_SERVICE_NAMESPACE}:${SIMULATOR_UDID}`)).toBe(
      ServiceState.RUNNING
    );
  });

  it.each([
    ["an Android emulator", "emulator-5554"],
    ["a physical iPhone", "00008110-001A2B3C4D5E6F70"],
    ["a provider's simulator", `ext:prov:${SIMULATOR_UDID}`],
    ["a remote simulator", `remote:${SIMULATOR_UDID}`],
  ])("leaves %s alone", async (_label, deviceId) => {
    const axFactory = vi.fn(async () => stubInstance());
    const registry = createWarmingRegistry(axFactory);

    await startSimulatorServer(registry, deviceId);

    expect(axFactory).not.toHaveBeenCalled();
  });

  it("ignores the simulator's other services", async () => {
    const axFactory = vi.fn(async () => stubInstance());
    const registry = createWarmingRegistry(axFactory);

    await startService(registry, `${NATIVE_DEVTOOLS_NAMESPACE}:${SIMULATOR_UDID}`);

    expect(axFactory).not.toHaveBeenCalled();
  });

  it("leaves a simulator whose simulator-server fails to start alone", async () => {
    const axFactory = vi.fn(async () => stubInstance());
    const registry = createWarmingRegistry(axFactory, failToStart);

    await startSimulatorServer(registry, SIMULATOR_UDID);

    expect(axFactory).not.toHaveBeenCalled();
  });

  it("keeps the simulator-server running when the warm-up fails", async () => {
    const axFactory = vi.fn(failToStart);
    const registry = createWarmingRegistry(axFactory);

    await startSimulatorServer(registry, SIMULATOR_UDID);

    expect(axFactory).toHaveBeenCalledTimes(1);
    expect(stateOf(registry, `${SIMULATOR_SERVER_NAMESPACE}:${SIMULATOR_UDID}`)).toBe(
      ServiceState.RUNNING
    );
  });
});

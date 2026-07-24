import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceState } from "@argent/registry";
import type { DeviceInfo, ToolCapability } from "@argent/registry";
import { assertSupported, UnsupportedOperationError } from "../../src/utils/capability";
import { SIMULATOR_SERVER_NAMESPACE } from "../../src/blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../src/blueprints/native-devtools";
import { AX_SERVICE_NAMESPACE } from "../../src/blueprints/ax-service";

// Spy the daemon-reset so the tool's orchestration is tested without shelling
// out. `recoverMock` is referenced lazily (inside an arrow) so the hoisted
// vi.mock factory doesn't touch it before it is initialized.
const recoverMock = vi.fn();
vi.mock("../../src/utils/coresimulator-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/coresimulator-recovery")>();
  return {
    ...actual,
    recoverCoreSimulatorInjection: (...args: unknown[]) => recoverMock(...args),
  };
});

import { createRecoverTouchInjectionTool } from "../../src/tools/simulator/recover-touch-injection";

const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"; // iOS-UDID shape → platform "ios"
const SIBLING_UDID = "11111111-2222-3333-4444-555555555555"; // another local iOS sim

function fakeRegistry(liveUrns: string[]) {
  const services = new Map<string, { state: ServiceState }>();
  for (const urn of liveUrns) services.set(urn, { state: ServiceState.RUNNING });
  const disposed: string[] = [];
  const registry = {
    getSnapshot: () => ({ services }),
    disposeService: async (urn: string) => {
      disposed.push(urn);
    },
  } as never;
  return { registry, disposed, services };
}

beforeEach(() => {
  recoverMock.mockReset();
  recoverMock.mockResolvedValue([{ step: "shutdown-all", ok: true }]);
});

describe("recover-touch-injection", () => {
  it("disposes the device's live services then runs the CoreSimulator recovery", async () => {
    const simUrn = `${SIMULATOR_SERVER_NAMESPACE}:${UDID}`;
    const axUrn = `${AX_SERVICE_NAMESPACE}:${UDID}`;
    const { registry, disposed } = fakeRegistry([simUrn, axUrn]);
    const tool = createRecoverTouchInjectionTool(registry);

    const result = await tool.execute({} as never, { udid: UDID });

    expect(disposed).toEqual(expect.arrayContaining([simUrn, axUrn]));
    expect(result.disposedServices).toEqual(expect.arrayContaining([simUrn, axUrn]));
    expect(recoverMock).toHaveBeenCalledWith(UDID, { rebootAfter: true });
    expect(result.recovered).toBe(true);
    expect(result.steps).toEqual([{ step: "shutdown-all", ok: true }]);
    expect(result.note).toMatch(/re-booted/i);
  });

  it("disposes EVERY local Apple simulator's services, not just the target's (the daemon kill is host-wide)", async () => {
    // A sibling's simulator-server keeps a live handle into the daemon being
    // killed; left alone it stays listening with a stale session.
    const targetUrn = `${SIMULATOR_SERVER_NAMESPACE}:${UDID}`;
    const siblingUrn = `${SIMULATOR_SERVER_NAMESPACE}:${SIBLING_UDID}`;
    const siblingTcpUrn = `${NATIVE_DEVTOOLS_NAMESPACE}:${SIBLING_UDID}:tcp`; // transport suffix form
    const androidUrn = `${SIMULATOR_SERVER_NAMESPACE}:emulator-5554`; // NOT CoreSimulator-backed
    const { registry, disposed } = fakeRegistry([targetUrn, siblingUrn, siblingTcpUrn, androidUrn]);
    const tool = createRecoverTouchInjectionTool(registry);

    const result = await tool.execute({} as never, { udid: UDID });

    expect(disposed).toEqual(expect.arrayContaining([targetUrn, siblingUrn, siblingTcpUrn]));
    expect(result.disposedServices).toEqual(
      expect.arrayContaining([targetUrn, siblingUrn, siblingTcpUrn])
    );
    // Android emulators don't talk to CoreSimulatorService — leave them alone.
    expect(disposed).not.toContain(androidUrn);
  });

  it("only reports services that were actually live", async () => {
    const simUrn = `${SIMULATOR_SERVER_NAMESPACE}:${UDID}`;
    const ndUrn = `${NATIVE_DEVTOOLS_NAMESPACE}:${UDID}`;
    const { registry, services } = fakeRegistry([simUrn]);
    services.set(ndUrn, { state: ServiceState.IDLE }); // present but idle → not disposed/reported
    const tool = createRecoverTouchInjectionTool(registry);

    const result = await tool.execute({} as never, { udid: UDID });

    expect(result.disposedServices).toContain(simUrn);
    expect(result.disposedServices).not.toContain(ndUrn);
  });

  it("reports recovered:false with a failure note when a recovery step hard-fails", async () => {
    recoverMock.mockResolvedValue([
      { step: "shutdown-all", ok: true, tolerated: true },
      { step: "killall-coresimulatorservice", ok: true },
      { step: "boot", ok: false, detail: "Unable to boot device" },
      { step: "bootstatus", ok: false, detail: "device not booted" },
    ]);
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry);

    const result = await tool.execute({} as never, { udid: UDID });

    // A tool that kills false-positive success must not return one itself.
    expect(result.recovered).toBe(false);
    expect(result.note).toMatch(/did not complete/i);
    expect(result.note).toMatch(/boot, bootstatus/);
  });

  it("threads rebootAfter:false through and adjusts the guidance", async () => {
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry);

    const result = await tool.execute({} as never, { udid: UDID, rebootAfter: false });

    expect(recoverMock).toHaveBeenCalledWith(UDID, { rebootAfter: false });
    expect(result.note).toMatch(/boot-device/);
  });

  it("declares iOS-simulator-only capability (rejects Android and physical iOS devices)", () => {
    const { registry } = fakeRegistry([]);
    const capability = createRecoverTouchInjectionTool(registry).capability as ToolCapability;

    const iosSim: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };
    const androidEmu: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    const iosDevice: DeviceInfo = { id: UDID, platform: "ios", kind: "device" };

    expect(() => assertSupported("recover-touch-injection", capability, iosSim)).not.toThrow();
    expect(() => assertSupported("recover-touch-injection", capability, androidEmu)).toThrow(
      UnsupportedOperationError
    );
    expect(() => assertSupported("recover-touch-injection", capability, iosDevice)).toThrow(
      UnsupportedOperationError
    );
  });
});

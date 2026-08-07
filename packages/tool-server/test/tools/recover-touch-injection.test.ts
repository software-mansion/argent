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

import {
  buildNote,
  createRecoverTouchInjectionTool,
} from "../../src/tools/simulator/recover-touch-injection";

const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"; // iOS-UDID shape → platform "ios"
const SIBLING_UDID = "11111111-2222-3333-4444-555555555555"; // another local iOS sim

const listSimulators = async () => [{ udid: UDID }, { udid: SIBLING_UDID }];

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

// The note is derived from which steps ran, so the mock is a full sequence.
const CLEAN_STEPS = [
  { step: "shutdown-all", ok: true },
  { step: "killall-coresimulatorservice", ok: true },
  { step: "boot", ok: true },
  { step: "bootstatus", ok: true },
];

beforeEach(() => {
  recoverMock.mockReset();
  recoverMock.mockResolvedValue(CLEAN_STEPS);
});

describe("recover-touch-injection", () => {
  it("disposes the device's live services then runs the CoreSimulator recovery", async () => {
    const simUrn = `${SIMULATOR_SERVER_NAMESPACE}:${UDID}`;
    const axUrn = `${AX_SERVICE_NAMESPACE}:${UDID}`;
    const { registry, disposed } = fakeRegistry([simUrn, axUrn]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const result = await tool.execute({} as never, { udid: UDID });

    expect(disposed).toEqual(expect.arrayContaining([simUrn, axUrn]));
    expect(result.disposedServices).toEqual(expect.arrayContaining([simUrn, axUrn]));
    expect(recoverMock).toHaveBeenCalledWith(UDID, { rebootAfter: true });
    expect(result.recovered).toBe(true);
    expect(result.steps).toEqual(CLEAN_STEPS);
    expect(result.note).toMatch(/daemon restarted and the target device is booted/i);
  });

  it("disposes EVERY local Apple simulator's services, not just the target's (the daemon kill is host-wide)", async () => {
    // A sibling's simulator-server keeps a live handle into the daemon being
    // killed; left alone it stays listening with a stale session.
    const targetUrn = `${SIMULATOR_SERVER_NAMESPACE}:${UDID}`;
    const siblingUrn = `${SIMULATOR_SERVER_NAMESPACE}:${SIBLING_UDID}`;
    const siblingTcpUrn = `${NATIVE_DEVTOOLS_NAMESPACE}:${SIBLING_UDID}:tcp`; // transport suffix form
    const androidUrn = `${SIMULATOR_SERVER_NAMESPACE}:emulator-5554`; // NOT CoreSimulator-backed
    const { registry, disposed } = fakeRegistry([targetUrn, siblingUrn, siblingTcpUrn, androidUrn]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

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
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

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
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const result = await tool.execute({} as never, { udid: UDID });

    // A tool that kills false-positive success must not return one itself.
    expect(result.recovered).toBe(false);
    expect(result.note).toMatch(/not confirmed booted/i);
    expect(result.note).toMatch(/boot, bootstatus/);
    expect(result.note).toMatch(/boot-device/); // the remedy that actually applies
  });

  it("threads rebootAfter:false through and adjusts the guidance", async () => {
    recoverMock.mockResolvedValue([
      { step: "shutdown-all", ok: true },
      { step: "killall-coresimulatorservice", ok: true },
    ]);
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const result = await tool.execute({} as never, { udid: UDID, rebootAfter: false });

    expect(recoverMock).toHaveBeenCalledWith(UDID, { rebootAfter: false });
    expect(result.note).toMatch(/left shut down/i);
    expect(result.note).toMatch(/boot-device/);
  });

  it("declares iOS-simulator-only capability (rejects Android and physical iOS devices)", () => {
    const { registry } = fakeRegistry([]);
    const capability = createRecoverTouchInjectionTool(registry, { listSimulators })
      .capability as ToolCapability;

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

  it("refuses a UDID that names no simulator on this host, before anything host-wide runs", async () => {
    const BOGUS = "DEADBEEF-0000-0000-0000-000000000000"; // valid shape, no such simulator
    const { registry, disposed } = fakeRegistry([`${SIMULATOR_SERVER_NAMESPACE}:${UDID}`]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    await expect(tool.execute({} as never, { udid: BOGUS })).rejects.toThrow(/no ios simulator/i);

    expect(recoverMock).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
  });

  it("says so when no simulators could be listed at all", async () => {
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators: async () => [] });

    await expect(tool.execute({} as never, { udid: UDID })).rejects.toThrow(/xcrun simctl/i);
    expect(recoverMock).not.toHaveBeenCalled();
  });

  it("rejects an empty udid at the schema (http.ts skips the capability gate on a falsy device arg)", () => {
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const schema = tool.zodSchema!;
    expect(schema.safeParse({ udid: "" }).success).toBe(false);
    expect(schema.safeParse({ udid: UDID }).success).toBe(true);
  });

  it("counts only siblings that actually came back, and names the ones that did not", async () => {
    // Sibling boots are tolerated on failure, so `ok` is true either way.
    recoverMock.mockResolvedValue([
      { step: "shutdown-all", ok: true },
      { step: "killall-coresimulatorservice", ok: true },
      { step: "boot", ok: true },
      { step: "boot:SIB-1", ok: true },
      { step: "boot:SIB-2", ok: true, tolerated: true, detail: "Shutting Down" },
      { step: "boot:SIB-3", ok: true, tolerated: true, detail: "Shutting Down" },
      { step: "bootstatus", ok: true },
    ]);
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const result = await tool.execute({} as never, { udid: UDID });

    expect(result.note).toMatch(/1 other previously-booted simulator\(s\) were also restarted/);
    expect(result.note).toMatch(/2 other previously-booted simulator\(s\) did NOT come back/);
  });

  it("surfaces a lost booted-device snapshot so the user knows siblings are stranded", async () => {
    recoverMock.mockResolvedValue([
      { step: "snapshot-booted", ok: true, tolerated: true, detail: "xcrun: timed out" },
      { step: "shutdown-all", ok: true },
      { step: "killall-coresimulatorservice", ok: true },
      { step: "boot", ok: true },
      { step: "bootstatus", ok: true },
    ]);
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    const result = await tool.execute({} as never, { udid: UDID });

    expect(result.note).toMatch(/snapshot could not be taken/i);
    expect(result.note).toMatch(/boot-device/);
  });

  it("is marked longRunning so the MCP client does not abort and retry the cold boot", () => {
    const { registry } = fakeRegistry([]);
    const tool = createRecoverTouchInjectionTool(registry, { listSimulators });

    expect(tool.longRunning).toBe(true);
  });
});

describe("buildNote", () => {
  it("does not tell the agent to boot or retry when the device is already up", () => {
    // `shutdown all` was SIGKILLed at its ceiling, so recovered is false — but
    // killall cleared the wedge and bootstatus confirmed the device is up.
    const note = buildNote(
      [
        { step: "shutdown-all", ok: false, detail: "Command failed: xcrun simctl shutdown all" },
        { step: "killall-coresimulatorservice", ok: true },
        { step: "boot", ok: true, tolerated: true, detail: "current state: Booted" },
        { step: "bootstatus", ok: true },
      ],
      true
    );

    expect(note).toMatch(/daemon restarted and the target device is booted/i);
    expect(note).toMatch(/shutdown-all failed/); // the real problem is still reported
    expect(note).not.toMatch(/may still be shut down/i);
    expect(note).not.toMatch(/retry this tool/i);
    expect(note).toMatch(/verify: true/); // re-check taps instead
  });

  it("says the wedge is still present, and how to clear it, when killall failed", () => {
    const note = buildNote(
      [
        { step: "shutdown-all", ok: true },
        { step: "killall-coresimulatorservice", ok: false, detail: "Operation not permitted" },
        { step: "boot", ok: true },
        { step: "bootstatus", ok: true },
      ],
      true
    );

    expect(note).toMatch(/NOT restarted/);
    expect(note).toMatch(/wedge is likely still present/i);
    expect(note).toMatch(/killall com\.apple\.CoreSimulator\.CoreSimulatorService/);
  });

  it("sends the user to boot-device only when the target is genuinely not up", () => {
    const note = buildNote(
      [
        { step: "shutdown-all", ok: true },
        { step: "killall-coresimulatorservice", ok: true },
        { step: "boot", ok: false, detail: "Invalid device" },
        { step: "bootstatus", ok: false, detail: "not booted" },
      ],
      true
    );

    expect(note).toMatch(/not confirmed booted/i);
    expect(note).toMatch(/Boot the device with boot-device/);
  });
});

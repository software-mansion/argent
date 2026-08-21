import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { resolveFlowDevice } from "../../src/tools/flows/flow-device";
import { UnsupportedOperationError } from "../../src/utils/capability";

/**
 * A physical iPhone is a listed, reachable device that the flow runner cannot
 * drive: `fetchFlowTree` sends every iOS device to the native view hierarchy,
 * and `nativeDevtoolsBlueprint` refuses `kind: "device"` because the dylib is
 * injected with `simctl spawn`. Without a check at resolution the runner accepts
 * the device and every selector step fails with a devtools error plus a
 * "restart the argent server" hint that cannot help — and auto-detection reaches
 * for the iPhone on its own, so a flow aimed at nothing in particular picks it.
 */
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function registryListing(devices: unknown[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices };
      throw new Error(`unexpected tool ${id}`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

const physicalEntry = {
  platform: "ios",
  kind: "device",
  udid: PHYSICAL_UDID,
  state: "connected",
};
const simEntry = { platform: "ios", kind: "simulator", udid: SIM_UDID, state: "Booted" };

describe("flow device resolution rejects a physical iPhone", () => {
  it("rejects it when named explicitly, naming the reason and an alternative", async () => {
    // `UnsupportedOperationError` is the class the HTTP layer maps to 400. A
    // bare FailureError would be served as a 500 — a server fault, which invites
    // a retry that can never succeed — while every other physical-iOS refusal
    // in the tool-server answers 400.
    await expect(
      resolveFlowDevice(registryListing([]), undefined, { device: PHYSICAL_UDID })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      resolveFlowDevice(registryListing([]), undefined, { device: PHYSICAL_UDID })
    ).rejects.toThrow(/native view hierarchy/i);
    await expect(
      resolveFlowDevice(registryListing([]), undefined, { device: PHYSICAL_UDID })
    ).rejects.toThrow(/describe \+ gesture-tap/i);
  });

  it("says why when it is the only ready device, rather than 'no booted device'", async () => {
    // `isBooted` counts `state: "connected"`, so an attached iPhone is what the
    // runner would otherwise have picked. Dropping it from the candidates must
    // not turn that into "no booted device found" printed beside a list that
    // shows one.
    await expect(
      resolveFlowDevice(registryListing([physicalEntry]), undefined, {})
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      resolveFlowDevice(registryListing([physicalEntry]), undefined, {})
    ).rejects.not.toThrow(/No booted device found/i);
  });

  it("does not let a plugged-in iPhone make an otherwise unambiguous simulator ambiguous", async () => {
    // The regression this guards: counting the iPhone as a candidate turns the
    // ordinary "one simulator running, phone on the desk" setup into
    // "2 booted devices matched — pass --device or --platform", for a device
    // that could never have been the answer.
    await expect(
      resolveFlowDevice(registryListing([physicalEntry, simEntry]), undefined, {})
    ).resolves.toMatchObject({ id: SIM_UDID, kind: "simulator" });
  });

  it("still resolves an iOS simulator (the rejection is scoped to hardware)", async () => {
    await expect(
      resolveFlowDevice(registryListing([simEntry]), undefined, { device: SIM_UDID })
    ).resolves.toMatchObject({ id: SIM_UDID, platform: "ios", kind: "simulator" });
    await expect(
      resolveFlowDevice(registryListing([simEntry]), undefined, {})
    ).resolves.toMatchObject({ id: SIM_UDID });
  });
});

import { describe, it, expect } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { nativeDevtoolsBlueprint } from "../../src/blueprints/native-devtools";

/**
 * The twin of `ax-service.test.ts`'s physical-device case. Both blueprints got
 * the same `kind === "device"` backstop in the same change, and only the
 * ax-service one was covered — so neutering this one left the whole suite green
 * while a hardware udid walked into a `simctl spawn` DYLD injection that cannot
 * reach a signed app on a device.
 *
 * The capability gate rejects the `native-*` tools before they get here, so this
 * guards the other way in: a direct service resolution (flows do exactly that
 * through `queryFullHierarchyTree`).
 */
const PHYSICAL: DeviceInfo = { id: "00008120-000E6D0C0ABBA01E", platform: "ios", kind: "device" };

describe("native-devtools blueprint refuses a physical iPhone", () => {
  it("rejects it before spawning, naming the device and the reason", async () => {
    const err = await nativeDevtoolsBlueprint
      .factory({}, "ignored" as unknown as DeviceInfo, { device: PHYSICAL })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/iOS-simulator-only/);
    expect((err as Error).message).toContain(PHYSICAL.id);
    expect(getFailureSignal(err as Error)?.error_code).toBe(
      FAILURE_CODES.NATIVE_DEVTOOLS_WRONG_PLATFORM
    );
  });

  it("is kind-shaped, not platform-shaped: a simulator gets past it", async () => {
    // Without this the guard could be narrowed to reject every iOS device and
    // the case above would stay green while native-devtools stopped working
    // entirely.
    const sim: DeviceInfo = {
      id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      platform: "ios",
      kind: "simulator",
    };
    const err = await nativeDevtoolsBlueprint
      .factory({}, "ignored" as unknown as DeviceInfo, { device: sim })
      .catch((e: unknown) => e);
    expect((err as Error | undefined)?.message ?? "").not.toMatch(/iOS-simulator-only/);
  });
});

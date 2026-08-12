import { describe, expect, it } from "vitest";
import {
  externalNativeId,
  externalProviderId,
  externalProviderLabel,
  isExternalDeviceUrn,
  isExternalId,
  makeExternalId,
  parseExternalId,
  PROVIDER_SCHEMA_VERSION,
  providerDeviceSchema,
  providerRecordSchema,
} from "../src/index.js";
import { androidDevice, ANDROID_SERIAL, iosDevice, IOS_UDID } from "./fixtures.js";

describe("external device ids", () => {
  it("round-trips through make / parse", () => {
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    expect(deviceId).toBe(`ext:acme-3f2a9c:${IOS_UDID}`);
    expect(isExternalId(deviceId)).toBe(true);
    expect(externalProviderId(deviceId)).toBe("acme-3f2a9c");
    expect(externalNativeId(deviceId)).toBe(IOS_UDID);
    expect(parseExternalId(deviceId)).toEqual({ nativeId: IOS_UDID, providerId: "acme-3f2a9c" });
  });

  it("preserves colons inside an adb serial", () => {
    const deviceId = makeExternalId("acme", "192.168.1.5:5555");
    expect(externalNativeId(deviceId)).toBe("192.168.1.5:5555");
    expect(externalProviderId(deviceId)).toBe("acme");
  });

  it("is the identity function for a non-external id", () => {
    expect(externalNativeId(IOS_UDID)).toBe(IOS_UDID);
    expect(externalNativeId(ANDROID_SERIAL)).toBe(ANDROID_SERIAL);
    expect(externalProviderId(IOS_UDID)).toBeUndefined();
  });

  it("reports only the vendor label for telemetry, never the instance suffix", () => {
    expect(externalProviderLabel(makeExternalId("acme-3f2a9c", IOS_UDID))).toBe("acme");
    expect(externalProviderLabel(makeExternalId("acme", IOS_UDID))).toBe("acme");
    expect(externalProviderLabel(IOS_UDID)).toBeUndefined();
  });

  /**
   * Malformed ids reach these helpers from tool params typed as plain strings,
   * so none may throw or an agent typo becomes a 500. An `undefined`/non-string
   * id arrives the same way, through a wrapper that doesn't re-validate the
   * inner schema; the class of bug the blueprint `device.id` guards exist for.
   */
  it.each([undefined, null, 42, {}])("does not throw on the non-string id %j", (deviceId) => {
    expect(() => isExternalId(deviceId as unknown as string)).not.toThrow();
    expect(isExternalId(deviceId as unknown as string)).toBe(false);
  });

  it.each([
    "ext:",
    "ext::",
    "ext:x",
    "ext:UPPER:abc",
    "ext:acme:",
    "ext:acme:-leading-dash",
    "ext:acme:has space",
    "ext:" + "a".repeat(64) + ":abc",
  ])("does not throw on the malformed id %j", (deviceId) => {
    expect(() => externalNativeId(deviceId)).not.toThrow();
    expect(() => externalProviderId(deviceId)).not.toThrow();
    expect(() => externalProviderLabel(deviceId)).not.toThrow();
    expect(parseExternalId(deviceId)).toBeUndefined();
  });

  it("tells a service URN for an external device apart from an ordinary one", () => {
    expect(isExternalDeviceUrn(`SimulatorServer:ext:acme:${IOS_UDID}`)).toBe(true);
    expect(isExternalDeviceUrn(`NativeDevtools:ext:acme:${IOS_UDID}#tcp`)).toBe(true);
    expect(isExternalDeviceUrn(`SimulatorServer:${IOS_UDID}`)).toBe(false);
    expect(isExternalDeviceUrn("no-colon")).toBe(false);
  });
});

describe("provider schemas", () => {
  /**
   * The version is frozen. Bumping it breaks every provider already in the wild
   * so it must be a deliberate edit here, not a side effect.
   */
  it("is still contract version 1", () => {
    expect(PROVIDER_SCHEMA_VERSION).toBe(1);
  });

  it("accepts the documented descriptor", () => {
    const parsed = providerRecordSchema.safeParse({
      devices: [iosDevice()],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      schemaVersion: 1,
      supportUrl: "https://example.invalid/issues",
      workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["an uppercase id", { id: "Acme" }],
    ["an id starting with a dash", { id: "-acme" }],
    ["a non-http supportUrl", { supportUrl: "file:///etc/passwd" }],
    ["a devices field that is not an array", { devices: {} }],
    ["an empty name", { name: "" }],
    ["a pid of zero", { pid: 0 }],
    ["a fractional pid", { pid: 12.5 }],
  ])("rejects a descriptor with %s", (_label, override) => {
    const parsed = providerRecordSchema.safeParse({
      devices: [],
      id: "acme",
      name: "Acme IDE",
      schemaVersion: 1,
      ...override,
    });

    expect(parsed.success).toBe(false);
  });

  /**
   * `pid` was added to v1 after the fact, which the contract allows only
   * because an optional field is non-breaking in both directions. A provider
   * that never heard of it still validates and one that writes it is not
   * rejected by a build that ignores it.
   */
  it("treats pid as optional on both sides", () => {
    const base = { devices: [], id: "acme", name: "Acme IDE", schemaVersion: 1 };
    expect(providerRecordSchema.safeParse(base).success).toBe(true);
    expect(providerRecordSchema.safeParse({ ...base, pid: 4321 }).success).toBe(true);
  });

  it("rejects a device with no capabilities array — absent never means allow", () => {
    const { capabilities: _dropped, ...withoutCapabilities } = iosDevice();
    expect(providerDeviceSchema.safeParse(withoutCapabilities).success).toBe(false);
  });

  it("accepts a device with an empty capabilities array (listable, but useless)", () => {
    const parsed = providerDeviceSchema.safeParse(
      iosDevice({ capabilities: [], simulatorServer: undefined })
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts unknown capability tokens so a provider may ship ahead of argent", () => {
    const parsed = providerDeviceSchema.safeParse(
      iosDevice({ capabilities: ["simulator-server", "teleportation"] })
    );
    expect(parsed.success).toBe(true);
  });

  it("requires simulatorServer when the simulator-server capability is declared", () => {
    const parsed = providerDeviceSchema.safeParse(iosDevice({ simulatorServer: undefined }));
    expect(parsed.success).toBe(false);
  });

  it("rejects a deviceSet on a non-iOS device", () => {
    const parsed = providerDeviceSchema.safeParse(
      androidDevice({ deviceSet: "/tmp/acme/Devices" })
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a nativeId that could inject argv flags into xcrun/adb", () => {
    expect(providerDeviceSchema.safeParse(iosDevice({ nativeId: "--set" })).success).toBe(false);
    expect(providerDeviceSchema.safeParse(iosDevice({ nativeId: "a b" })).success).toBe(false);
  });

  it("validates a whole descriptor (the conformance command's entry point)", () => {
    const parsed = providerRecordSchema.safeParse({
      devices: [androidDevice(), iosDevice()],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      schemaVersion: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a descriptor with no devices array — [] is how you say 'nothing booted'", () => {
    const baseRecord = { id: "acme", name: "Acme IDE", schemaVersion: 1 };
    expect(providerRecordSchema.safeParse(baseRecord).success).toBe(false);
    expect(providerRecordSchema.safeParse({ ...baseRecord, devices: [] }).success).toBe(true);
  });
});

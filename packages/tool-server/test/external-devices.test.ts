import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { argentHomeDir } from "@argent/configuration-core";
import {
  ALLOWED_SIM_SERVER_ENDPOINTS,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_PREFIX,
  PROVIDER_ID_SHAPE,
  PROVIDER_SCHEMA_VERSION,
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  assertAllowedSimServerEndpoint,
  assertExternalCapability,
  discoverProviders,
  disposeExternalDeviceServices,
  externalNativeId,
  externalProviderId,
  externalProviderLabel,
  externalClaimForNativeId,
  externalSupportHint,
  isExternalDeviceUrn,
  isExternalId,
  listExternalDevices,
  findExternalDevice,
  lookupExternalDevice,
  makeExternalId,
  type ProviderDevice,
  providerDeviceSchema,
  type ProviderRecord,
  providerRecordSchema,
  providersDirectory,
  revalidateExternalDevice,
} from "../src/utils/external-devices";
import { classifyDevice, resolveDevice } from "../src/utils/device-info";
import { adbArgv } from "../src/utils/adb";
import {
  deviceSetForUdid,
  simctlArgsForUdid,
  simctlArgsForUdidSync,
  simctlTargetForUdid,
  simctlTargetForUdidSync,
} from "../src/utils/ios-device-sets";

const ANDROID_SERIAL = "emulator-5554";
/** A pid nothing can be running under, so `kill(0)` fails with ESRCH. */
const DEAD_PID = 0x7fffffff;
const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";

function androidDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["adb", "simulator-server"],
    kind: "emulator",
    name: "Pixel 8",
    nativeId: ANDROID_SERIAL,
    platform: "android",
    simulatorServer: {
      apiUrl: "http://127.0.0.1:52002",
      streamUrl: "http://127.0.0.1:52002/stream.mjpeg",
    },
    state: "device",
    ...overrides,
  };
}

function iosDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: ["ax-service", "simctl", "simulator-server"],
    deviceSet: "/tmp/acme/Devices/iOS",
    kind: "simulator",
    name: "iPhone 16 Pro",
    nativeId: IOS_UDID,
    platform: "ios",
    simulatorServer: {
      apiUrl: "http://127.0.0.1:52001",
      streamUrl: "http://127.0.0.1:52001/stream.mjpeg",
      version: "1.20.0",
    },
    state: "Booted",
    ...overrides,
  };
}

/**
 * A stand-in for the simulator-server a provider would be running. Discovery
 * probes `apiUrl` for liveness, so a device that wants to survive it needs
 * something actually listening.
 */
type FakeSimulatorServer = {
  apiUrl: string;
  close: () => Promise<void>;
  streamUrl: string;
};

async function createFakeSimulatorServer(): Promise<FakeSimulatorServer> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = (server.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
  };
}

/**
 * A port with nothing on it, so devices pointing here fail the liveness probe:
 * how a descriptor left behind by a crashed provider behaves.
 */
const DEAD_API_URL = "http://127.0.0.1:1";

let temporaryDirectory: string;
const cleanups: Array<() => Promise<void> | void> = [];

function writeDescriptor(name: string, body: unknown): string {
  const descriptorPath = path.join(temporaryDirectory, name);
  fs.writeFileSync(descriptorPath, typeof body === "string" ? body : JSON.stringify(body));
  return descriptorPath;
}

function useDescriptors(...files: string[]): void {
  process.env.ARGENT_DEVICE_PROVIDERS = files.join(",");
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-providers-"));
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function startSimulatorServer(): Promise<FakeSimulatorServer> {
  const simulatorServer = await createFakeSimulatorServer();
  cleanups.push(() => simulatorServer.close());
  return simulatorServer;
}

/**
 * Write a conformant descriptor whose single iOS device points at a live
 * simulator-server, so it survives the discovery probe. `overrides` patches
 * the record, `deviceOverrides` the device.
 */
async function liveDescriptor(
  overrides: Record<string, unknown> = {},
  deviceOverrides: Record<string, unknown> = {},
  name = "acme.json"
): Promise<string> {
  const simulatorServer = await startSimulatorServer();

  return writeDescriptor(name, {
    devices: [
      iosDevice({
        simulatorServer: {
          apiUrl: simulatorServer.apiUrl,
          streamUrl: simulatorServer.streamUrl,
          version: "1.20.0",
        },
        ...deviceOverrides,
      }),
    ],
    id: "acme-3f2a9c",
    name: "Acme IDE",
    schemaVersion: 1,
    supportUrl: "https://example.invalid/issues",
    workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    ...overrides,
  });
}

/**
 * The contract itself is tested in `packages/device-providers/test/`; id
 * round-trips, schema acceptance and rejection, the discovery policies. What is
 * left here is everything that only exists once the tool-server is in the
 * picture: `classifyDevice`, `FailureError`, the liveness probe, the revocation
 * cache and the argv builders.
 */
describe("the contract's tool-server facade", () => {
  /**
   * The one genuine hazard of `@argent/device-providers` resolving the home
   * directory itself (its dependency list is zod and nothing else) is that the
   * writer and the reader could end up pointed at different directories. There
   * is no way to catch that inside the package; here, where both are on the
   * dependency list, there is.
   */
  it("resolves the same providers directory as the shared config paths do", () => {
    expect(providersDirectory()).toBe(path.join(argentHomeDir(), "providers"));
  });

  /**
   * Third parties resolve the contract through this module and its header
   * promises the export set never shrinks. A re-export dropped during a refactor
   * is silent until someone's build breaks, so name them.
   */
  it("re-exports the whole contract surface", () => {
    expect(PROVIDER_SCHEMA_VERSION).toBe(1);
    expect(EXTERNAL_PREFIX).toBe("ext:");
    expect(PROVIDER_ID_SHAPE.test("acme-3f2a9c")).toBe(true);
    expect([...EXTERNAL_CAPABILITIES]).toContain("simulator-server");
    expect([...ALLOWED_SIM_SERVER_ENDPOINTS]).toEqual(["/api/pointer", "/api/screenshot", "/ws"]);

    /**
     * The type re-exports matter as much as the value ones and nothing at
     * runtime can check them, so they are annotated here. Dropping either from
     * the facade fails `typecheck:tests`.
     */
    const device: ProviderDevice = providerDeviceSchema.parse(iosDevice());
    expect(device.nativeId).toBe(IOS_UDID);

    const record: ProviderRecord = providerRecordSchema.parse({
      devices: [iosDevice()],
      id: "acme",
      name: "Acme",
      schemaVersion: 1,
    });
    expect(record.devices).toHaveLength(1);

    for (const fn of [
      isExternalId,
      isExternalDeviceUrn,
      makeExternalId,
      externalNativeId,
      externalProviderId,
      externalProviderLabel,
      discoverProviders,
      providersDirectory,
      __resetProviderWarningsForTesting,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});

describe("external device ids", () => {
  /**
   * Malformed ids reach these helpers from tool params typed as plain strings,
   * so none may throw or an agent typo becomes a 500. An
   * `undefined`/non-string id arrives the same way, through a wrapper that
   * doesn't re-validate the inner schema — the class of bug the blueprint
   * `device.id` guards exist for.
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
    expect(() => classifyDevice(deviceId)).not.toThrow();
    expect(() => resolveDevice(deviceId)).not.toThrow();
  });

  it("classifies by the native id's shape, not by the prefix", () => {
    expect(classifyDevice(makeExternalId("acme", IOS_UDID))).toBe("ios");
    expect(classifyDevice(makeExternalId("acme", ANDROID_SERIAL))).toBe("android");
    expect(resolveDevice(makeExternalId("acme", IOS_UDID))).toEqual({
      id: `ext:acme:${IOS_UDID}`,
      platform: "ios",
      kind: "simulator",
    });

    /**
     * The emulator/device split must see through the prefix too, or an
     * attached emulator would be driven by the physical-device controller.
     */
    expect(resolveDevice(makeExternalId("acme", ANDROID_SERIAL)).kind).toBe("emulator");
    expect(resolveDevice(makeExternalId("acme", "ABC123XYZ")).kind).toBe("device");
  });
});

describe("discovery", () => {
  it("fans out across several descriptor files", async () => {
    const simA = await startSimulatorServer();
    const simB = await startSimulatorServer();

    useDescriptors(
      writeDescriptor("a.json", {
        devices: [
          iosDevice({ simulatorServer: { apiUrl: simA.apiUrl, streamUrl: simA.streamUrl } }),
        ],
        id: "acme",
        name: "Acme",
        schemaVersion: 1,
      }),
      writeDescriptor("b.json", {
        devices: [
          androidDevice({ simulatorServer: { apiUrl: simB.apiUrl, streamUrl: simB.streamUrl } }),
        ],
        id: "beta",
        name: "Beta",
        schemaVersion: 1,
      })
    );

    expect(
      discoverProviders()
        .map((provider) => provider.id)
        .sort()
    ).toEqual(["acme", "beta"]);

    const devices = await listExternalDevices();

    expect(devices.map((device) => device.id).sort()).toEqual(
      [makeExternalId("acme", IOS_UDID), makeExternalId("beta", ANDROID_SERIAL)].sort()
    );
  });

  it("keeps only the first descriptor claiming a given id", async () => {
    useDescriptors(
      writeDescriptor("a.json", { devices: [], id: "acme", name: "First", schemaVersion: 1 }),
      writeDescriptor("b.json", { devices: [], id: "acme", name: "Second", schemaVersion: 1 })
    );
    const found = discoverProviders();
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("First");
  });

  it("skips an unknown schemaVersion without failing, and says so once", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    useDescriptors(
      writeDescriptor("v2.json", { devices: [], id: "acme", name: "Acme", schemaVersion: 2 })
    );

    expect(discoverProviders()).toEqual([]);
    await expect(listExternalDevices()).resolves.toEqual([]);
    discoverProviders();
    discoverProviders();

    const versionLines = stderr.mock.calls.filter((call) =>
      String(call[0]).includes("unsupported schemaVersion")
    );

    expect(versionLines).toHaveLength(1);
  });

  it.each([
    ["unparseable JSON", "{ not json"],
    ["a truncated atomic write", '{"schemaVersion":1,"id":"acm'],
  ])("treats %s as absent", async (_label, body) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    useDescriptors(writeDescriptor("broken.json", body));
    expect(discoverProviders()).toEqual([]);
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  it("treats a missing file as absent", async () => {
    useDescriptors(path.join(temporaryDirectory, "does-not-exist.json"));
    expect(discoverProviders()).toEqual([]);
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  it("never unlinks a descriptor, whatever is wrong with it", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const badVersion = writeDescriptor("bad.json", { schemaVersion: 99 });
    const brokenJson = writeDescriptor("broken.json", "{{{");

    const deadServer = writeDescriptor("dead.json", {
      devices: [iosDevice({ simulatorServer: { apiUrl: DEAD_API_URL, streamUrl: DEAD_API_URL } })],
      id: "gone",
      name: "Gone",
      schemaVersion: 1,
    });

    useDescriptors(badVersion, brokenJson, deadServer);
    await listExternalDevices();

    for (const descriptorPath of [badVersion, brokenJson, deadServer]) {
      expect(fs.existsSync(descriptorPath)).toBe(true);
    }
  });

  it("skips discovery entirely under ARGENT_DISABLE_DEVICE_PROVIDERS", async () => {
    useDescriptors(await liveDescriptor());
    process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
    expect(discoverProviders()).toEqual([]);
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  it("drops one bad device without costing the provider its whole list", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const simulatorServer = await startSimulatorServer();
    const endpoint = { apiUrl: simulatorServer.apiUrl, streamUrl: simulatorServer.streamUrl };

    useDescriptors(
      writeDescriptor("acme.json", {
        devices: [
          iosDevice({ simulatorServer: endpoint }),
          { nativeId: "x", platform: "ios" },
          androidDevice({ simulatorServer: endpoint }),
        ],
        id: "acme",
        name: "Acme",
        schemaVersion: 1,
      })
    );

    const devices = await listExternalDevices();

    expect(devices.map((device) => device.nativeId).sort()).toEqual(
      [ANDROID_SERIAL, IOS_UDID].sort()
    );
  });

  it("rejects a device whose declared platform disagrees with its id's shape", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    useDescriptors(await liveDescriptor({}, { nativeId: ANDROID_SERIAL }));
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  it("filters unknown capability tokens out of the adopted device", async () => {
    useDescriptors(
      await liveDescriptor({}, { capabilities: ["simulator-server", "teleportation"] })
    );
    const [device] = await listExternalDevices();
    expect(Array.from(device!.capabilities)).toEqual(["simulator-server"]);
  });
});

/**
 * The signal that replaces an endpoint's `ECONNREFUSED`. It matters most for
 * the case a provider cannot handle itself: killed with `SIGKILL` it never
 * unlinks its descriptor, so without the probe its devices would linger
 * forever.
 */
describe("liveness probe", () => {
  it("drops a device whose simulator-server is not listening", async () => {
    useDescriptors(
      await liveDescriptor(
        {},
        { simulatorServer: { apiUrl: DEAD_API_URL, streamUrl: DEAD_API_URL } }
      )
    );
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  it("keeps a device whose simulator-server answers, even with a 404", async () => {
    useDescriptors(await liveDescriptor());
    const devices = await listExternalDevices();
    expect(devices).toHaveLength(1);
  });

  it("stops listing a provider's devices once its server dies", async () => {
    const simulatorServer = await startSimulatorServer();

    useDescriptors(
      await liveDescriptor(
        {},
        {
          simulatorServer: { apiUrl: simulatorServer.apiUrl, streamUrl: simulatorServer.streamUrl },
        }
      )
    );

    await expect(listExternalDevices()).resolves.toHaveLength(1);
    await simulatorServer.close();
    await expect(listExternalDevices()).resolves.toEqual([]);
  });

  /**
   * A device offering only `adb`/`simctl` has no server to probe. Absent
   * evidence is not evidence of death. It passes through and fails later on
   * its own terms if the mechanism it does grant is broken.
   */
  it("passes through a device that publishes no simulator-server", async () => {
    useDescriptors(
      await liveDescriptor({}, { capabilities: ["simctl"], simulatorServer: undefined })
    );
    const devices = await listExternalDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.simulatorServer).toBeUndefined();
  });

  it("can be skipped, for callers that only want what the file declares", async () => {
    useDescriptors(
      await liveDescriptor(
        {},
        { simulatorServer: { apiUrl: DEAD_API_URL, streamUrl: DEAD_API_URL } }
      )
    );

    await expect(listExternalDevices({ probe: false })).resolves.toHaveLength(1);
  });

  /**
   * Dispatch deliberately does not probe. The caller is about to connect
   * anyway and a dead server surfaces as the connection-refused
   * `recoverable()` already handles.
   */
  it("does not gate lookup — a dead server still resolves", async () => {
    useDescriptors(
      await liveDescriptor(
        {},
        { simulatorServer: { apiUrl: DEAD_API_URL, streamUrl: DEAD_API_URL } }
      )
    );

    await expect(
      lookupExternalDevice(makeExternalId("acme-3f2a9c", IOS_UDID))
    ).resolves.toMatchObject({ nativeId: IOS_UDID });
  });
});

describe("lookupExternalDevice", () => {
  it("resolves a live device", async () => {
    useDescriptors(await liveDescriptor());
    const device = await lookupExternalDevice(makeExternalId("acme-3f2a9c", IOS_UDID));
    expect(device.name).toBe("iPhone 16 Pro");
    expect(device.provider.name).toBe("Acme IDE");
    expect(device.provider.workspace).toEqual({ name: "my-app", path: "/Users/me/src/my-app" });
  });

  it("names the provider when the device has been withdrawn", async () => {
    const descriptorPath = await liveDescriptor();
    useDescriptors(descriptorPath);

    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({ schemaVersion: 1, id: "acme-3f2a9c", name: "Acme IDE", devices: [] })
    );

    await expect(lookupExternalDevice(makeExternalId("acme-3f2a9c", IOS_UDID))).rejects.toThrow(
      /Acme IDE/
    );
  });

  it("explains that the provider is gone when no descriptor matches", async () => {
    useDescriptors();
    await expect(lookupExternalDevice(makeExternalId("nobody", IOS_UDID))).rejects.toThrow(
      /No device provider named 'nobody'/
    );
  });

  /**
   * The file is the source of truth, so no cache can disagree with it. That is
   * what lets revocation take effect on the very next call.
   */
  it("sees an edit to the file immediately, with no cache in the way", async () => {
    const descriptorPath = await liveDescriptor();
    useDescriptors(descriptorPath);
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    expect((await lookupExternalDevice(deviceId)).name).toBe("iPhone 16 Pro");

    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    descriptor.devices[0].name = "iPad Pro";
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    expect((await lookupExternalDevice(deviceId)).name).toBe("iPad Pro");
  });

  it("findExternalDevice is the same read, without the throw", async () => {
    useDescriptors(await liveDescriptor());
    expect(findExternalDevice(makeExternalId("acme-3f2a9c", IOS_UDID))?.nativeId).toBe(IOS_UDID);
    expect(findExternalDevice(makeExternalId("nobody", IOS_UDID))).toBeUndefined();
    expect(findExternalDevice(IOS_UDID)).toBeUndefined();
  });
});

/**
 * The raw-udid half of the lookup. Argent's own discovery paths — the simulator
 * watcher, `boot-device` — never see an `ext:` id, so without this a provider's
 * grant would bind to one spelling of a device rather than to the device.
 */
describe("externalClaimForNativeId", () => {
  it("finds the provider claiming a device by its real udid", async () => {
    useDescriptors(await liveDescriptor());

    const claim = externalClaimForNativeId(IOS_UDID);

    expect(claim?.id).toBe(makeExternalId("acme-3f2a9c", IOS_UDID));
    expect(claim?.provider.name).toBe("Acme IDE");
  });

  it("returns nothing for a device no provider claims", async () => {
    useDescriptors(await liveDescriptor());

    expect(externalClaimForNativeId("99999999-9999-9999-9999-999999999999")).toBeUndefined();
    expect(externalClaimForNativeId(ANDROID_SERIAL)).toBeUndefined();
  });

  it("returns nothing when no provider is registered at all", () => {
    expect(externalClaimForNativeId(IOS_UDID)).toBeUndefined();
  });

  /** The `ext:` spelling has `findExternalDevice`; no provider declares one. */
  it("returns nothing for an ext: id", async () => {
    useDescriptors(await liveDescriptor());

    expect(externalClaimForNativeId(makeExternalId("acme-3f2a9c", IOS_UDID))).toBeUndefined();
  });

  /**
   * A provider killed without unlinking must not keep argent off a simulator it
   * legitimately owns. The claim is only as live as the process behind it.
   */
  it("ignores a claim whose provider process is gone", async () => {
    useDescriptors(await liveDescriptor({ pid: DEAD_PID }));

    expect(externalClaimForNativeId(IOS_UDID)).toBeUndefined();
  });

  it("honors a claim from a live provider process", async () => {
    useDescriptors(await liveDescriptor({ pid: process.pid }));

    expect(externalClaimForNativeId(IOS_UDID)?.provider.name).toBe("Acme IDE");
  });

  /** Absent pid is no evidence of death, so the claim binds. */
  it("honors a claim from a provider that published no pid", async () => {
    useDescriptors(await liveDescriptor());

    expect(externalClaimForNativeId(IOS_UDID)?.provider.name).toBe("Acme IDE");
  });
});

describe("assertExternalCapability", () => {
  it("is a no-op for a device argent booted itself", async () => {
    await expect(
      assertExternalCapability(
        "AXService",
        { id: IOS_UDID, platform: "ios", kind: "simulator" },
        "ax-service"
      )
    ).resolves.toBeUndefined();
  });

  it("allows a declared mechanism", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    await expect(
      assertExternalCapability("AXService", deviceId, "ax-service")
    ).resolves.toBeUndefined();
  });

  it("denies an undeclared mechanism, naming the provider", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    await expect(
      assertExternalCapability("NativeDevtools", deviceId, "native-devtools")
    ).rejects.toThrow(/Acme IDE did not grant the 'native-devtools' capability/);

    await expect(
      assertExternalCapability("JsRuntimeDebugger", deviceId, "js-debugger")
    ).rejects.toThrow(/Acme IDE did not grant the 'js-debugger' capability/);
  });

  /**
   * Attribution lives only in the HTTP dispatch edge, which appends it to
   * every `ext:` failure. An error spelling out the support URL
   * itself would print it twice in the message the agent sees.
   */
  it("leaves the support url to the single attribution point", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    await expect(
      assertExternalCapability("NativeDevtools", deviceId, "native-devtools")
    ).rejects.not.toThrow(/example\.invalid\/issues/);

    await expect(lookupExternalDevice(makeExternalId("nobody", IOS_UDID))).rejects.not.toThrow(
      /provided by/
    );
  });

  it("denies every mechanism when the provider granted none", async () => {
    useDescriptors(await liveDescriptor({}, { capabilities: [], simulatorServer: undefined }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    for (const capability of EXTERNAL_CAPABILITIES) {
      await expect(assertExternalCapability("Any", deviceId, capability)).rejects.toThrow();
    }
  });

  /**
   * The gate authorises the device, not the id it arrived under. Every path
   * that reaches a provider's simulator by its real udid — the watcher,
   * `boot-device`, anything `additionalDeviceSets` surfaces — walks past a gate
   * keyed on the `ext:` spelling alone.
   */
  it("denies every mechanism on the raw udid of a claimed device", async () => {
    useDescriptors(await liveDescriptor({}, { capabilities: [], simulatorServer: undefined }));

    for (const capability of EXTERNAL_CAPABILITIES) {
      await expect(assertExternalCapability("Any", IOS_UDID, capability)).rejects.toThrow(
        /Acme IDE did not grant/
      );
    }
  });

  it("allows a declared mechanism on the raw udid too", async () => {
    useDescriptors(await liveDescriptor());

    await expect(
      assertExternalCapability("AXService", IOS_UDID, "ax-service")
    ).resolves.toBeUndefined();

    await expect(
      assertExternalCapability(
        "AXService",
        { id: IOS_UDID, platform: "ios", kind: "simulator" },
        "ax-service"
      )
    ).resolves.toBeUndefined();
  });

  it("denies an undeclared mechanism on a DeviceInfo carrying the raw udid", async () => {
    useDescriptors(await liveDescriptor());

    await expect(
      assertExternalCapability(
        "NativeDevtools",
        { id: IOS_UDID, platform: "ios", kind: "simulator" },
        "native-devtools"
      )
    ).rejects.toThrow(/Acme IDE did not grant the 'native-devtools' capability/);
  });

  it("leaves the raw udid ungated once its provider's process is gone", async () => {
    useDescriptors(await liveDescriptor({ pid: DEAD_PID }, { capabilities: [] }));

    await expect(
      assertExternalCapability("NativeDevtools", IOS_UDID, "native-devtools")
    ).resolves.toBeUndefined();
  });
});

describe("revocation", () => {
  function fakeRegistry(urns: string[]) {
    const disposed: string[] = [];

    return {
      disposed,
      disposeService: async (urn: string) => {
        disposed.push(urn);
      },
      getSnapshot: () => ({ services: new Map(urns.map((urn) => [urn, {}])) }),
    };
  }

  function rewrite(descriptorPath: string, devices: unknown[]): void {
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({ schemaVersion: 1, id: "acme-3f2a9c", name: "Acme IDE", devices })
    );
  }

  /**
   * No TTL to wait out. The file is re-read on every call, so a narrowed grant
   * is visible to the very next dispatch. That immediacy is the dividend of
   * the file-based contract.
   */
  it("reports staleness immediately when the provider narrows what it grants", async () => {
    const descriptorPath = await liveDescriptor();
    useDescriptors(descriptorPath);
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await lookupExternalDevice(deviceId);

    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    descriptor.devices[0].capabilities = ["simulator-server"];
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));

    const result = revalidateExternalDevice(deviceId);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/capabilities/);
  });

  it("reports staleness when the device disappears entirely", async () => {
    const descriptorPath = await liveDescriptor();
    useDescriptors(descriptorPath);
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await lookupExternalDevice(deviceId);
    rewrite(descriptorPath, []);
    expect(revalidateExternalDevice(deviceId)).toMatchObject({ stale: true });
  });

  it("reports no staleness while nothing has changed", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await lookupExternalDevice(deviceId);
    expect(revalidateExternalDevice(deviceId)).toEqual({ stale: false });
  });

  it("is a no-op for a device argent booted itself", () => {
    expect(revalidateExternalDevice(IOS_UDID)).toEqual({ stale: false });
  });

  it("drops every cached service bound to the device, suffixes included", async () => {
    const deviceId = makeExternalId("acme", IOS_UDID);
    const registry = fakeRegistry([
      `SimulatorServer:${deviceId}`,
      `NativeDevtools:${deviceId}#tcp`,
      `AXService:${deviceId}`,
      `SimulatorServer:${IOS_UDID}`,
      `ChromiumCdp:chromium-cdp-9222`,
    ]);
    const disposed = await disposeExternalDeviceServices(registry, deviceId);
    expect(disposed.sort()).toEqual(
      [
        `SimulatorServer:${deviceId}`,
        `NativeDevtools:${deviceId}#tcp`,
        `AXService:${deviceId}`,
      ].sort()
    );
    /** The identically-named local device must survive. */
    expect(registry.disposed).not.toContain(`SimulatorServer:${IOS_UDID}`);
  });
});

describe("simulator-server endpoint parity", () => {
  it.each(["/ws", "/api/screenshot", "/api/pointer"])("allows %s", (endpoint) => {
    expect(() => assertAllowedSimServerEndpoint(endpoint)).not.toThrow();
  });

  /**
   * These exist only in builds compiled with the recording / clipboard /
   * license features. Argent's own build has none, so using one would mean
   * consuming a capability argent does not itself provide.
   */
  it.each(["/api/video/start", "/api/video/stop", "/api/clipboard/text", "/api/token/verify"])(
    "refuses %s",
    (endpoint) => {
      expect(() => assertAllowedSimServerEndpoint(endpoint)).toThrow(/Refusing to call/);
    }
  );
});

describe("simctl argv for a provider device", () => {
  it("is the identity for an ordinary device and performs no I/O", async () => {
    await expect(
      simctlArgsForUdid(IOS_UDID, ["launch", IOS_UDID, "com.example.app"])
    ).resolves.toEqual(["simctl", "launch", IOS_UDID, "com.example.app"]);
    expect(simctlArgsForUdidSync(IOS_UDID, ["spawn", IOS_UDID, "launchctl", "list"])).toEqual([
      "simctl",
      "spawn",
      IOS_UDID,
      "launchctl",
      "list",
    ]);
  });

  it("scopes to the provider's device set and substitutes the native id", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(
      simctlArgsForUdid(deviceId, ["launch", deviceId, "com.example.app"])
    ).resolves.toEqual([
      "simctl",
      "--set",
      "/tmp/acme/Devices/iOS",
      "launch",
      IOS_UDID,
      "com.example.app",
    ]);
  });

  it("substitutes the id everywhere it appears, in any position", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(
      simctlArgsForUdid(deviceId, ["privacy", deviceId, "grant", "camera", "com.example.app"])
    ).resolves.toEqual([
      "simctl",
      "--set",
      "/tmp/acme/Devices/iOS",
      "privacy",
      IOS_UDID,
      "grant",
      "camera",
      "com.example.app",
    ]);
  });

  it("omits --set when the provider keeps its simulators in the default set", async () => {
    useDescriptors(await liveDescriptor({}, { deviceSet: undefined }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(
      simctlArgsForUdid(deviceId, ["launch", deviceId, "com.example.app"])
    ).resolves.toEqual(["simctl", "launch", IOS_UDID, "com.example.app"]);
  });

  it("refuses when the provider withheld the simctl capability", async () => {
    useDescriptors(await liveDescriptor({}, { capabilities: ["simulator-server"] }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(
      simctlArgsForUdid(deviceId, ["launch", deviceId, "com.example.app"])
    ).rejects.toThrow(/'simctl' capability/);
  });

  /** The sync form reads the file directly, so it needs no preceding lookup. */
  it("works synchronously with no preceding lookup", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    expect(simctlArgsForUdidSync(deviceId, ["spawn", deviceId, "launchctl", "list"])).toEqual([
      "simctl",
      "--set",
      "/tmp/acme/Devices/iOS",
      "spawn",
      IOS_UDID,
      "launchctl",
      "list",
    ]);
  });

  it("throws rather than silently targeting the default set when the device is gone", () => {
    useDescriptors();
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    expect(() => simctlArgsForUdidSync(deviceId, ["spawn", deviceId, "launchctl", "list"])).toThrow(
      /not currently offered/
    );
  });

  /**
   * Callers that issue a run of `simctl` commands for one device resolve the
   * prefix and the target id together. Taking only the prefix (the shape this
   * replaced) got `--set` right while passing the `ext:` id straight to
   * `simctl`, which reaches nothing.
   */
  it("pairs the device set with the native id for a run of commands", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    await expect(simctlTargetForUdid(deviceId)).resolves.toEqual({
      nativeId: IOS_UDID,
      prefix: ["simctl", "--set", "/tmp/acme/Devices/iOS"],
    });

    expect(simctlTargetForUdidSync(deviceId)).toEqual({
      nativeId: IOS_UDID,
      prefix: ["simctl", "--set", "/tmp/acme/Devices/iOS"],
    });
  });

  /** Every shape that yields `simctl` argv checks the same grant. */
  it("gates the pair and sync forms exactly like the single-call form", async () => {
    useDescriptors(await liveDescriptor({}, { capabilities: ["simulator-server"] }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    await expect(simctlTargetForUdid(deviceId)).rejects.toThrow(/'simctl' capability/);
    expect(() => simctlTargetForUdidSync(deviceId)).toThrow(/'simctl' capability/);
    expect(() => simctlArgsForUdidSync(deviceId, ["spawn", deviceId, "launchctl", "list"])).toThrow(
      /'simctl' capability/
    );
  });

  /**
   * Blueprints whose mechanism is implemented with `simctl` spawns
   * (`ax-service`, `native-profiler`) name their own grant instead.
   */
  it("lets the granted mechanism stand in for simctl where it is the implementation", async () => {
    useDescriptors(await liveDescriptor({}, { capabilities: ["ax-service"] }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);

    expect(simctlTargetForUdidSync(deviceId, { granted: "ax-service" })).toEqual({
      nativeId: IOS_UDID,
      prefix: ["simctl", "--set", "/tmp/acme/Devices/iOS"],
    });

    await expect(simctlTargetForUdid(deviceId)).rejects.toThrow(/'simctl' capability/);
  });

  it("leaves an ordinary udid and the default set untouched", async () => {
    await expect(simctlTargetForUdid(IOS_UDID)).resolves.toEqual({
      nativeId: IOS_UDID,
      prefix: ["simctl"],
    });
  });

  /**
   * The provider states its device set, so this is answered from the
   * descriptor rather than by probing each configured set the way a local
   * simulator's is. That is also what makes the answer follow a device that
   * moves or is withdrawn, with nothing memoized to go stale.
   */
  it("answers the owning device set from the descriptor, without probing", async () => {
    useDescriptors(await liveDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(deviceSetForUdid(deviceId)).resolves.toBe("/tmp/acme/Devices/iOS");
  });

  it("reports the default set when the provider declared none", async () => {
    useDescriptors(await liveDescriptor({}, { deviceSet: undefined }));
    const deviceId = makeExternalId("acme-3f2a9c", IOS_UDID);
    await expect(deviceSetForUdid(deviceId)).resolves.toBeNull();
  });
});

describe("adb argv for a provider device", () => {
  async function androidDescriptor(deviceOverrides: Record<string, unknown> = {}): Promise<string> {
    const simulatorServer = await startSimulatorServer();

    return writeDescriptor("acme-android.json", {
      devices: [
        androidDevice({
          simulatorServer: {
            apiUrl: simulatorServer.apiUrl,
            streamUrl: simulatorServer.streamUrl,
          },
          ...deviceOverrides,
        }),
      ],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      schemaVersion: 1,
    });
  }

  it("substitutes the serial when the provider granted adb", async () => {
    useDescriptors(await androidDescriptor());
    const deviceId = makeExternalId("acme-3f2a9c", ANDROID_SERIAL);

    expect(adbArgv(["-s", deviceId, "shell", "ls"])).toEqual(["-s", ANDROID_SERIAL, "shell", "ls"]);
  });

  /**
   * Refusing the substitution refuses the mechanism: `adb` itself has never
   * heard of an `ext:` id.
   */
  it("refuses to reveal the serial when the provider withheld adb", async () => {
    useDescriptors(await androidDescriptor({ capabilities: ["simulator-server"] }));
    const deviceId = makeExternalId("acme-3f2a9c", ANDROID_SERIAL);

    expect(() => adbArgv(["-s", deviceId, "shell", "ls"])).toThrow(/'adb' capability/);
  });

  it("refuses a device that is no longer offered, rather than passing the ext: id through", async () => {
    useDescriptors();
    const deviceId = makeExternalId("acme-3f2a9c", ANDROID_SERIAL);

    expect(() => adbArgv(["-s", deviceId, "shell", "ls"])).toThrow(/No device provider/);
  });

  it("leaves an ordinary argv alone without any lookup", () => {
    useDescriptors();
    expect(adbArgv(["-s", ANDROID_SERIAL, "shell", "ls"])).toEqual([
      "-s",
      ANDROID_SERIAL,
      "shell",
      "ls",
    ]);
  });
});

describe("externalSupportHint", () => {
  it("names the provider and where to report", async () => {
    useDescriptors(await liveDescriptor());
    expect(externalSupportHint(makeExternalId("acme-3f2a9c", IOS_UDID))).toBe(
      "This device is provided by Acme IDE. Report issues at https://example.invalid/issues."
    );
  });

  it("still names the provider when it published no support url", async () => {
    useDescriptors(await liveDescriptor({ supportUrl: undefined }));
    expect(externalSupportHint(makeExternalId("acme-3f2a9c", IOS_UDID))).toBe(
      "This device is provided by Acme IDE."
    );
  });

  it("returns undefined for a device argent booted itself", () => {
    expect(externalSupportHint(IOS_UDID)).toBeUndefined();
  });
});

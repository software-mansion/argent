import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { DeviceInfo } from "@argent/registry";
import type { IosEndpoint } from "../../src/utils/ios-host";

/** The endpoint the factory hands the daemon, one per factory call. */
const endpoints: IosEndpoint[] = [];

/**
 * A daemon that records where it was told to dial, then exits before
 * connecting.
 */
const exitingDaemon = (endpoint: IosEndpoint): ChildProcess => {
  endpoints.push({ ...endpoint });
  const proc = new EventEmitter() as ChildProcess & { killed: boolean };
  proc.killed = false;

  Object.assign(proc, {
    kill: () => {
      proc.killed = true;
      return true;
    },
    stderr: null,
    stdout: null,
  });

  setImmediate(() => proc.emit("exit", 1));

  return proc;
};

vi.mock("../../src/utils/ios-host", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-host")>(
    "../../src/utils/ios-host"
  );

  return {
    ...actual,
    pickIosHost: () => ({
      bootstrapAx: async () => ({ entitlementBypassActive: true }),
      kind: "local",
      requiresTcp: false,
      spawnAxDaemon: (_udid: string, endpoint: IosEndpoint) => exitingDaemon(endpoint),
      startProxy: async () => {},
      stopProxy: async () => {},
    }),
  };
});

/**
 * The capability gate reads the provider's descriptor; these devices are
 * granted.
 */
vi.mock("../../src/utils/external-devices", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/external-devices")>(
    "../../src/utils/external-devices"
  );

  return { ...actual, assertExternalCapability: async () => {} };
});

import { axServiceBlueprint } from "../../src/blueprints/ax-service";

const sha = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);

const socketPathFor = async (id: string): Promise<string> => {
  const device: DeviceInfo = { id, platform: "ios", kind: "simulator" };

  await expect(axServiceBlueprint.factory({}, device, { device })).rejects.toThrow(
    /exited with code 1/
  );

  const endpoint = endpoints.at(-1);

  if (endpoint?.transport !== "unix") throw new Error("expected a unix endpoint");

  return endpoint.socketPath;
};

afterEach(() => {
  endpoints.length = 0;
});

describe("ax-service socket path", () => {
  it("gives each device of an external provider its own socket", async () => {
    /**
     * The first 8 characters of both ids are `ext:acme`, so a path built from
     * them would be shared by the two devices.
     */
    const first = "ext:acme-3f2a9c:B6C52FD4-5408-402B-9369-EF7C66B98E6F";
    const second = "ext:acme-3f2a9c:8BDBFD47-E557-41BA-926B-2DD39A17A53E";

    expect(await socketPathFor(first)).toBe(`/tmp/ax-${sha(first)}.sock`);
    expect(await socketPathFor(second)).toBe(`/tmp/ax-${sha(second)}.sock`);
  });

  it("keeps the 8-character path of a plain UDID", async () => {
    /** A UDID no other test file binds, as test files run in parallel. */
    expect(await socketPathFor("5D2E1C0A-7F3B-4E9D-A1C6-0B8F2D4E6A13")).toBe(
      "/tmp/ax-5D2E1C0A.sock"
    );
  });
});

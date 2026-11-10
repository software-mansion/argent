import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";

const startProxy = vi.fn(async (_udid: string, _port: number) => {});
const stopProxy = vi.fn(async () => {});
const spawnAxDaemon = vi.fn();

// A remote iOS host, whose `requiresTcp` puts the factory on the branch that
// binds a TCP listener and then wires the reverse tunnel.
vi.mock("../../src/utils/ios-host", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-host")>(
    "../../src/utils/ios-host"
  );
  return {
    ...actual,
    pickIosHost: () => ({
      ...actual.remoteIosHost,
      bootstrapAx: async () => ({ entitlementBypassActive: true }),
      spawnAxDaemon,
      startProxy,
      stopProxy,
    }),
  };
});

import type { DeviceInfo } from "@argent/registry";
import { axServiceBlueprint } from "../../src/blueprints/ax-service";
import { processScopedUdid } from "../helpers/process-scoped-udid";

const device: DeviceInfo = {
  id: processScopedUdid("-3333-3333-3333-333333333333"),
  platform: "ios-remote",
  kind: "simulator",
};

const rebind = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });

afterEach(() => {
  startProxy.mockReset();
  stopProxy.mockReset();
  spawnAxDaemon.mockReset();
});

describe("axServiceBlueprint factory — tcp transport", () => {
  it("closes the listener when startProxy throws", async () => {
    let boundPort = 0;
    startProxy.mockImplementation(async (_udid: string, port: number) => {
      boundPort = port;
      throw new Error("sim-remote reverse start refused");
    });

    await expect(axServiceBlueprint.factory({}, device, { device })).rejects.toThrow(
      /reverse start refused/
    );

    expect(boundPort).toBeGreaterThan(0);
    expect(spawnAxDaemon).not.toHaveBeenCalled();
    // The factory threw before the registry could record an instance, so
    // nothing will ever call dispose: the port has to be free already.
    await expect(rebind(boundPort)).resolves.toBeUndefined();
  });
});

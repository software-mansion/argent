import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";

const startProxy = vi.fn(async (_udid: string, _port: number) => {});
const stopProxy = vi.fn(async () => {});

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
      startProxy,
      stopProxy,
    }),
  };
});

import type { DeviceInfo } from "@argent/registry";
import { nativeDevtoolsBlueprint } from "../../src/blueprints/native-devtools";
import { processScopedUdid } from "../helpers/process-scoped-udid";

const device: DeviceInfo = {
  id: processScopedUdid("-2222-2222-2222-222222222222"),
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
  vi.restoreAllMocks();
  startProxy.mockReset();
  stopProxy.mockReset();
});

describe("nativeDevtoolsBlueprint factory — tcp transport", () => {
  it("closes the listener when startProxy throws", async () => {
    let boundPort = 0;
    startProxy.mockImplementation(async (_udid: string, port: number) => {
      boundPort = port;
      throw new Error("sim-remote proxy start refused");
    });

    await expect(nativeDevtoolsBlueprint.factory({}, device, { device })).rejects.toThrow(
      /proxy start refused/
    );

    expect(boundPort).toBeGreaterThan(0);
    // The factory threw before the registry could record an instance, so
    // nothing will ever call dispose: the port has to be free already.
    await expect(rebind(boundPort)).resolves.toBeUndefined();
  });
});

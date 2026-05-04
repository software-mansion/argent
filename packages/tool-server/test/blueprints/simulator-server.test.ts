import { describe, it, expect } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { simulatorServerBlueprint } from "../../src/blueprints/simulator-server";

/**
 * Regression for the bug where a missing `udid` reached the simulator-server
 * blueprint factory, the child was spawned with `--id undefined`, and the
 * stderr handler later threw `TypeError: Cannot read properties of undefined
 * (reading 'slice')` — that error fired inside an async event listener and
 * propagated to the process-wide `uncaughtException` handler, killing the
 * entire tool-server.
 *
 * Reachable in the wild via tool wrappers that don't re-validate the inner
 * tool's schema (e.g. `flow-add-step` with stringified `args` that omit
 * `udid`). The factory must reject the bad input synchronously with a
 * descriptive Error rather than spawning the child at all.
 */
describe("simulator-server blueprint — input validation", () => {
  it("rejects when options.device is missing", async () => {
    await expect(simulatorServerBlueprint.factory({}, "ignored")).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  it("rejects when device.id is undefined", async () => {
    const device = { id: undefined, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is an empty string", async () => {
    const device: DeviceInfo = { id: "", platform: "ios", kind: "simulator" };
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is a non-string value", async () => {
    const device = { id: 42, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });
});

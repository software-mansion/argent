import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Registry } from "@argent/registry";

const invokeSubTool = vi.fn();
const pending = vi.hoisted(() => ({ simctl: false, devicectl: false }));

vi.mock("../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: (wrapper: "simctl" | "devicectl") => pending[wrapper],
}));

vi.mock("../src/utils/sub-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sub-invoke")>()),
  invokeSubTool: (...a: unknown[]) => invokeSubTool(...a),
}));

import { resolveFlowDevice } from "../src/tools/flows/flow-device";

const HARMONY_ENTRY = {
  platform: "harmony",
  kind: "device",
  udid: "harmony-127.0.0.1:5555",
  state: "Connected",
};

const IOS_REMOTE_ENTRY = {
  platform: "ios-remote",
  udid: "remote-6DBF83B4-0000-0000-0000-000000000000",
  state: "Shutdown",
};

describe("flow device resolution — ids of devices no flow auto-resolves", () => {
  it("names each device by the id it is listed under when nothing resolves", async () => {
    // Nothing resolves, so the error enumerates what the caller can pass.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY, IOS_REMOTE_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      "Available devices: harmony-127.0.0.1:5555 (harmony, Connected), " +
        "remote-6DBF83B4-0000-0000-0000-000000000000 (ios-remote, Shutdown)."
    );
  });

  it("never adopts one as the booted device it resolved by itself", async () => {
    // Harmony is never auto-resolved, but an explicit id is allowed: on 6.1.1 a
    // run degrades per step rather than dead-ending.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      /No booted device found/
    );
  });
});

describe("flow device resolution - while Xcode's component install is pending", () => {
  const BOOTED_ANDROID = { platform: "android", serial: "emulator-5554", state: "device" };
  const BOOTED_ANDROID_2 = { platform: "android", serial: "emulator-5556", state: "device" };
  const PLAIN =
    "No booted device found. Pass a device id or platform explicitly. Available devices: none.";

  beforeEach(() => {
    pending.simctl = false;
    pending.devicectl = false;
  });

  it("adds the reason to the error when no platform was given", async () => {
    pending.simctl = true;
    invokeSubTool.mockResolvedValue({ devices: [] });

    const error = await resolveFlowDevice({} as Registry, undefined, {}).catch((e: Error) => e);
    expect((error as Error).message).toMatch(
      /^No booted device found\. Pass a device id or platform explicitly\. (The )?Xcode .*has not finished installing .*-runFirstLaunch.* Available devices: none\.$/
    );
  });

  it("adds the reason when the run is scoped to ios", async () => {
    pending.devicectl = true;
    invokeSubTool.mockResolvedValue({ devices: [] });

    await expect(resolveFlowDevice({} as Registry, undefined, { platform: "ios" })).rejects.toThrow(
      /No booted ios device found\..*has not finished installing/
    );
  });

  it("leaves it out when the run is scoped to another platform", async () => {
    pending.simctl = true;
    invokeSubTool.mockResolvedValue({ devices: [] });

    await expect(
      resolveFlowDevice({} as Registry, undefined, { platform: "android" })
    ).rejects.toThrow(
      "No booted android device found. Pass a device id or platform explicitly. Available devices: none."
    );
  });

  it("leaves the message as it was when nothing is pending, whatever hint list-devices carries", async () => {
    invokeSubTool.mockResolvedValue({
      devices: [],
      hint: "adb is reached through a server on port 5038.",
    });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(PLAIN);
    const error = await resolveFlowDevice({} as Registry, undefined, { platform: "ios" }).catch(
      (e: Error) => e
    );
    expect((error as Error).message).toBe(
      "No booted ios device found. Pass a device id or platform explicitly. Available devices: none."
    );
  });

  it("leaves the ambiguity message alone", async () => {
    pending.simctl = true;
    invokeSubTool.mockResolvedValue({ devices: [BOOTED_ANDROID, BOOTED_ANDROID_2] });

    const error = await resolveFlowDevice({} as Registry, undefined, {}).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "2 booted devices matched \u2014 pass --device or --platform to disambiguate. " +
        "Available devices: emulator-5554 (android, device), emulator-5556 (android, device)."
    );
  });
});

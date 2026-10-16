import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Registry } from "@argent/registry";

const invokeSubTool = vi.fn();

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

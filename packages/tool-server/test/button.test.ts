import { describe, it, expect, vi } from "vitest";

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send so no real socket is opened during the test.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

import { buttonTool } from "../src/tools/button";
import { UnsupportedOperationError } from "../src/utils/capability";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const services = { simulatorServer: {} } as never;

describe("button tool — per-platform validation", () => {
  it("rejects `back` on iOS (no hardware back button) instead of a silent no-op", async () => {
    await expect(
      buttonTool.execute(services, { udid: iosUdid, button: "back" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("rejects `actionButton` on Android", async () => {
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "actionButton" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("accepts `back` on Android (it is a real hardware key there)", async () => {
    await expect(
      buttonTool.execute(services, { udid: androidUdid, button: "back" })
    ).resolves.toEqual({ pressed: "back" });
  });

  it("accepts every iOS-valid button", async () => {
    for (const button of ["home", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"] as const) {
      await expect(
        buttonTool.execute(services, { udid: iosUdid, button })
      ).resolves.toEqual({ pressed: button });
    }
  });
});

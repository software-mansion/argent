import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";

// Mock the device shutdown so no real `simctl`/`adb` runs in the suite; the
// route's own validation + ownership handling is what's under test.
const shutdownDevice = vi.fn();
vi.mock("../src/utils/device-shutdown", () => ({
  shutdownDevice: (id: string) => shutdownDevice(id),
}));

import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";

const IOS_UDID = "00000000-0000-0000-0000-000000000000";
const IOS_UDID_2 = "11111111-1111-1111-1111-111111111111";

// Registry answers list-devices with `devices` (used by the known-device guard).
function harness(devices: unknown[]) {
  const invokeTool = vi.fn(async () => ({ devices }));
  const registry = { invokeTool } as unknown as Registry;
  const app = express();
  app.use(express.json());
  app.use(createPreviewRouter(registry));
  return { app };
}

beforeEach(() => {
  variantProposalStore.takeOwnedDevices(); // clear singleton ownership
  shutdownDevice.mockReset();
});

describe("POST /preview/shutdown/:udid", () => {
  it("shuts down a known device and drops Lens ownership", async () => {
    shutdownDevice.mockResolvedValue({ ok: true });
    const { app } = harness([{ platform: "ios", udid: IOS_UDID, state: "Booted" }]);
    variantProposalStore.markDeviceOwned(IOS_UDID);

    const res = await request(app).post(`/shutdown/${IOS_UDID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(shutdownDevice).toHaveBeenCalledWith(IOS_UDID);
    // No longer running → Lens must not try to kill it again at session end.
    expect(variantProposalStore.isDeviceOwned(IOS_UDID)).toBe(false);
  });

  it("rejects an unknown udid without invoking shutdown (auth-exempt exec guard)", async () => {
    const { app } = harness([{ platform: "ios", udid: IOS_UDID, state: "Booted" }]);

    const res = await request(app).post(`/shutdown/${IOS_UDID_2}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown device");
    expect(shutdownDevice).not.toHaveBeenCalled();
  });

  it("surfaces a shutdown failure as a 400 carrying the reason", async () => {
    shutdownDevice.mockResolvedValue({ ok: false, error: "simctl: boom" });
    const { app } = harness([{ platform: "ios", udid: IOS_UDID, state: "Booted" }]);

    const res = await request(app).post(`/shutdown/${IOS_UDID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("simctl: boom");
  });
});

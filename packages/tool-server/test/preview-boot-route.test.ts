import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";
import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";

const IOS_UDID = "00000000-0000-0000-0000-000000000000";
const IOS_UDID_2 = "11111111-1111-1111-1111-111111111111";
const ANDROID_SERIAL = "emulator-5554";

// Build an app whose registry answers list-devices with `devices` and records
// every boot-device invocation so the test can assert what was (not) booted.
function harness(devices: unknown[]) {
  const bootCalls: unknown[] = [];
  const invokeTool = vi.fn(async (id: string, params?: unknown) => {
    if (id === "boot-device") {
      bootCalls.push(params);
      return { platform: "ios", udid: (params as { udid: string }).udid, booted: true };
    }
    return { devices };
  });
  const registry = { invokeTool } as unknown as Registry;
  const app = express();
  app.use(express.json());
  app.use(createPreviewRouter(registry));
  return { app, invokeTool, bootCalls };
}

beforeEach(() => {
  // The store is a process singleton; clear any ownership a prior test left.
  variantProposalStore.takeOwnedDevices();
});

describe("POST /preview/boot", () => {
  it("boots a stopped iOS sim headless and marks it Lens-owned", async () => {
    const { app, bootCalls } = harness([{ platform: "ios", udid: IOS_UDID, state: "Shutdown" }]);

    const res = await request(app).post("/boot").send({ udid: IOS_UDID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ booted: true, alreadyRunning: false, owned: true });
    // Booted headless (no Simulator.app window).
    expect(bootCalls).toEqual([{ udid: IOS_UDID, headless: true }]);
    expect(variantProposalStore.isDeviceOwned(IOS_UDID)).toBe(true);
  });

  it("does NOT boot or own a sim that is already running", async () => {
    const { app, bootCalls } = harness([{ platform: "ios", udid: IOS_UDID, state: "Booted" }]);

    const res = await request(app).post("/boot").send({ udid: IOS_UDID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyRunning: true, owned: false });
    expect(bootCalls).toEqual([]); // never re-booted
    expect(variantProposalStore.isDeviceOwned(IOS_UDID)).toBe(false);
  });

  it("rejects an unknown udid without booting (auth-exempt spawn guard)", async () => {
    const { app, bootCalls } = harness([{ platform: "ios", udid: IOS_UDID, state: "Shutdown" }]);

    const res = await request(app).post("/boot").send({ udid: IOS_UDID_2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown device");
    expect(bootCalls).toEqual([]);
    expect(variantProposalStore.isDeviceOwned(IOS_UDID_2)).toBe(false);
  });

  it("rejects a non-iOS device (Android emulators aren't bootable from the preview)", async () => {
    const { app, bootCalls } = harness([
      { platform: "android", serial: ANDROID_SERIAL, state: "offline" },
    ]);

    const res = await request(app).post("/boot").send({ udid: ANDROID_SERIAL });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("iOS simulators");
    expect(bootCalls).toEqual([]);
  });

  it("400s on a missing udid", async () => {
    const { app } = harness([]);
    const res = await request(app).post("/boot").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing");
  });
});

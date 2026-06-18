import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";

// The reverted /preview/describe route calls the internal per-platform
// adapters directly (NOT the public `describe` tool, whose output is now a
// token-efficient text `{ description }` since main #197). Mock the adapters
// so the test exercises the route's own logic — platform dispatch, the
// structured-tree passthrough, the no-store header, and the 500 error shape —
// without any device / adb / ax-service I/O.
vi.mock("../src/tools/describe/platforms/ios", () => ({ describeIos: vi.fn() }));
vi.mock("../src/tools/describe/platforms/android", () => ({ describeAndroid: vi.fn() }));

import { createPreviewRouter } from "../src/preview";
import { describeIos } from "../src/tools/describe/platforms/ios";
import { describeAndroid } from "../src/tools/describe/platforms/android";

const mockedIos = describeIos as unknown as Mock;
const mockedAndroid = describeAndroid as unknown as Mock;

// Pure string inputs to `classifyDevice` (a regex, NO device interaction):
// an all-zero UUID matches the 8-4-4-4-12 hex shape -> "ios"; a non-UUID
// serial -> "android". No simulator/emulator is touched by this unit test.
const IOS_UDID = "00000000-0000-0000-0000-000000000000";
const ANDROID_SERIAL = "emulator-5554";
// `chromium-cdp-<port>` is classified as platform "chromium" by shape alone.
const CHROMIUM_ID = "chromium-cdp-9222";

const TREE = {
  role: "AXGroup",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    { role: "Button", frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, label: "Tap me" },
  ],
};

// The route now guards the udid against the live device list (mirrors
// /simulator-server/:udid) before dispatching the describe adapter — so the
// fake registry must answer list-devices. By default it reports BOTH the iOS
// udid and the Android serial as present, so the existing dispatch tests keep
// passing; the unknown-device test overrides this with an empty list.
function makeApp(
  devices: unknown[] = [
    { platform: "ios", udid: IOS_UDID },
    { platform: "android", serial: ANDROID_SERIAL },
  ]
) {
  const registry = {
    invokeTool: vi.fn(async () => ({ devices })),
  } as unknown as Registry;
  const app = express();
  app.use(createPreviewRouter(registry));
  return app;
}

beforeEach(() => {
  mockedIos.mockReset();
  mockedAndroid.mockReset();
});

describe("GET /preview/describe/:udid (describe-based; post-#197 text-contract revert)", () => {
  it("iOS udid -> describeIos; returns the STRUCTURED tree, not the text {description}", async () => {
    mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service" });

    const res = await request(makeApp()).get(`/describe/${IOS_UDID}`);

    expect(res.status).toBe(200);
    // The entire reason for the revert: the preview UI reads `j.tree`. If the
    // route ever routes back through the public `describe` tool, the body
    // collapses to `{ description: "<text>" }` and the spotlight dies silently.
    // This assertion is that regression's tripwire.
    expect(res.body).toHaveProperty("tree");
    expect(res.body).not.toHaveProperty("description");
    expect(res.body.tree).toEqual(TREE);
    expect(res.body.source).toBe("ax-service");
    expect(res.headers["cache-control"]).toBe("no-store");

    expect(mockedIos).toHaveBeenCalledTimes(1);
    expect(mockedAndroid).not.toHaveBeenCalled();
    // dispatched with an ios-classified DeviceInfo (mirrors dispatchByPlatform)
    expect(mockedIos.mock.calls[0]![1]).toMatchObject({ platform: "ios" });
  });

  it("Android serial -> describeAndroid (platform dispatch matches the describe tool)", async () => {
    mockedAndroid.mockResolvedValue({ tree: TREE, source: "uiautomator" });

    const res = await request(makeApp()).get(`/describe/${ANDROID_SERIAL}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tree");
    expect(res.body).not.toHaveProperty("description");
    expect(res.body.source).toBe("uiautomator");
    expect(mockedAndroid).toHaveBeenCalledTimes(1);
    // dispatched as describeAndroid(registry, serial) — mirrors the describe tool
    expect(mockedAndroid).toHaveBeenCalledWith(expect.anything(), ANDROID_SERIAL);
    expect(mockedIos).not.toHaveBeenCalled();
  });

  it("forwards should_restart verbatim when the adapter sets it", async () => {
    mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service", should_restart: true });

    const res = await request(makeApp()).get(`/describe/${IOS_UDID}`);

    expect(res.status).toBe(200);
    expect(res.body.should_restart).toBe(true);
  });

  it("Chromium id -> 400 { error }; neither describe adapter is touched", async () => {
    const res = await request(makeApp()).get(`/describe/${CHROMIUM_ID}`);

    // A chromium id must be rejected before dispatch — otherwise it falls into
    // the else-branch and shells `adb` against a non-existent serial, 500ing
    // with a misleading message. Mirrors the /simulator-server/:udid guard.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Chromium");
    expect(mockedIos).not.toHaveBeenCalled();
    expect(mockedAndroid).not.toHaveBeenCalled();
  });

  it("adapter throw -> 500 { error } (non-fatal: UI skips the !d.ok branch)", async () => {
    mockedIos.mockRejectedValue(new Error("ax-service query timed out"));

    const res = await request(makeApp()).get(`/describe/${IOS_UDID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("ax-service query timed out");
  });

  it("unknown udid -> 400; no describe adapter (no xcrun/adb subprocess) is touched", async () => {
    // This route is auth-exempt and `describeIos`/`describeAndroid` shell out
    // to xcrun/adb. An unknown id must be rejected BEFORE dispatch so a flood
    // of distinct ids can't amplify into unbounded subprocess spawns. The udid
    // is shape-valid (so it isn't the chromium branch) but absent from the
    // device list the mock returns (empty).
    const res = await request(makeApp([])).get(`/describe/${IOS_UDID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown device");
    expect(res.body.error).toContain("/preview/simulators");
    expect(mockedIos).not.toHaveBeenCalled();
    expect(mockedAndroid).not.toHaveBeenCalled();
  });
});

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
// `amazon-<id>` is classified as platform "vega" by shape alone.
const VEGA_ID = "amazon-vvd-0001";

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
    // (The guard rejects any non-ios/android platform; the message names the
    // rejected platform, e.g. "chromium".)
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("chromium");
    expect(res.body.error).toContain("not available");
    expect(mockedIos).not.toHaveBeenCalled();
    expect(mockedAndroid).not.toHaveBeenCalled();
  });

  it("Vega (amazon-) id -> 400; guard rejects any non-ios/android, not only chromium", async () => {
    // Regression guard for the broadened check: a vega serial must NOT fall
    // through to describeAndroid (which would shell `adb -s amazon-...` against
    // a non-existent serial). Would still pass if the guard were chromium-only.
    const res = await request(makeApp()).get(`/describe/${VEGA_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("vega");
    expect(res.body.error).toContain("not available");
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

// Integration coverage for the two preview-UI route handlers PR #394 changed to
// go through `serveUiFile` (the dot-path fix). preview-ui-dotfile.test.ts tests
// the helper in isolation under a dot dir; this mounts the REAL router (as
// http.ts does, at "/preview") and serves the actual packages/ui files, so the
// route wiring — findUiFile resolution, content-type, no-store, the "/" → "/"
// trailing-slash redirect, and the missing-file 404 branch — is guarded too.
describe("preview UI routes (real router, real packages/ui)", () => {
  function previewApp() {
    const registry = { invokeTool: vi.fn() } as unknown as Registry;
    const app = express();
    app.use("/preview", createPreviewRouter(registry));
    return app;
  }

  it("GET /preview/theme.css -> 200 text/css, no-store, real stylesheet", async () => {
    const res = await request(previewApp()).get("/preview/theme.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
    expect(res.headers["cache-control"]).toBe("no-store, must-revalidate");
    expect(res.text).toContain("Argent Preview");
  });

  it("GET /preview/ -> 200 text/html, the real index.html", async () => {
    const res = await request(previewApp()).get("/preview/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store, must-revalidate");
    expect(res.text).toContain("<!doctype html>");
  });

  it("GET /preview (no trailing slash) -> 301 to /preview/ so relative theme.css resolves", async () => {
    const res = await request(previewApp()).get("/preview");
    expect(res.status).toBe(301);
    expect(res.headers["location"]).toBe("/preview/");
  });
});

// Both /describe/:udid and /simulator-server/:udid validate the :udid against
// the live device list to keep these auth-exempt routes from amplifying forged
// ids into subprocess spawns. The preview UI polls /describe ~3×/s while
// variants are on screen, and `argent lens` holds the window open across rounds
// — so validating by re-invoking `list-devices` (itself a storm of
// `xcrun`/`adb`/`ps` spawns) per request was the "spamming list-devices" bug.
// These guard the short-lived known-device cache that fixes it.
describe("known-device validation cache (preview /describe + /simulator-server)", () => {
  // Harness that exposes the registry mock so call counts are assertable.
  // resolveService is stubbed so the /simulator-server happy path resolves.
  function harness(
    devices: unknown[] = [
      { platform: "ios", udid: IOS_UDID },
      { platform: "android", serial: ANDROID_SERIAL },
    ]
  ) {
    const invokeTool = vi.fn(async () => ({ devices }));
    const resolveService = vi.fn(async () => ({
      apiUrl: "http://127.0.0.1:65000/",
      streamUrl: "http://127.0.0.1:65000/stream",
    }));
    const registry = { invokeTool, resolveService } as unknown as Registry;
    const app = express();
    app.use(createPreviewRouter(registry));
    return { app, invokeTool };
  }

  it("polling /describe repeatedly invokes list-devices ONCE, not per request", async () => {
    mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service" });
    const { app, invokeTool } = harness();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`/describe/${IOS_UDID}`);
      expect(res.status).toBe(200);
    }

    // The fix: validation is served from the cache after the first refresh, so
    // 5 describe polls cost ONE list-devices call (was 5 — the spam).
    expect(invokeTool).toHaveBeenCalledTimes(1);
    // Every poll still describes — only the device-list validation is cached.
    expect(mockedIos).toHaveBeenCalledTimes(5);
  });

  it("/simulators primes the cache so a following /describe doesn't re-list", async () => {
    mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service" });
    const { app, invokeTool } = harness();

    const sims = await request(app).get(`/simulators`);
    expect(sims.status).toBe(200);
    expect(invokeTool).toHaveBeenCalledTimes(1);

    const desc = await request(app).get(`/describe/${IOS_UDID}`);
    expect(desc.status).toBe(200);
    // No extra list-devices: the connect/poll path rides the list /simulators
    // already fetched for its dropdown.
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("/simulator-server validation is cached too (connect path doesn't re-list)", async () => {
    const { app, invokeTool } = harness();

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(`/simulator-server/${ANDROID_SERIAL}`);
      expect(res.status).toBe(200);
    }
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("an unknown id is still rejected from cache without re-listing per request", async () => {
    const { app, invokeTool } = harness([{ platform: "ios", udid: IOS_UDID }]);

    for (let i = 0; i < 4; i++) {
      const res = await request(app).get(`/describe/${"11111111-1111-1111-1111-111111111111"}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unknown device");
    }
    // A flood of forged ids shares one refresh instead of one list-devices each
    // — the cache tightens the DoS guard rather than weakening it.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(mockedIos).not.toHaveBeenCalled();
  });

  it("re-lists once the cache goes stale (a disappeared/new device is eventually seen)", async () => {
    // Fake only the clock (Date), not setTimeout — supertest's own timers stay
    // real, so its requests resolve normally while we control cache staleness.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(1_000_000));
      mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service" });
      const { app, invokeTool } = harness();

      await request(app).get(`/describe/${IOS_UDID}`);
      expect(invokeTool).toHaveBeenCalledTimes(1);

      // Within the TTL → still cached.
      vi.setSystemTime(new Date(1_000_000 + 4_000));
      await request(app).get(`/describe/${IOS_UDID}`);
      expect(invokeTool).toHaveBeenCalledTimes(1);

      // Past the TTL → one refresh.
      vi.setSystemTime(new Date(1_000_000 + 6_000));
      await request(app).get(`/describe/${IOS_UDID}`);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

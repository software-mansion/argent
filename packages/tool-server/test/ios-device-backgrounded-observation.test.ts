import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import { describeIosDevice } from "../src/tools/describe/platforms/ios-device";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { queryIosDeviceFlowTree } from "../src/tools/flows/flow-ios-tree";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";
import {
  clearCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// Since the runner stopped re-fronting a backgrounded app for observation-only
// snapshots (APP_BACKGROUNDED), every consumer of the snapshot must degrade in
// its own documented shape instead of leaking a raw throw. These tests pin the
// composed behavior per consumer: describe fails with the actionable message,
// the wait tools report their unreadable / not-settled shapes (so the MCP
// auto-screenshot after `button home` still runs and now captures the home
// screen, nothing having re-fronted the app), and the flow tree read fails the
// step loudly.

// Physical-iOS UDID shape (8 hex, dash, 16 hex); see utils/device-info.ts.
const UDID = "00008110-000978540290401E";
const BUNDLE_ID = "com.example.app";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "device" };

const BACKGROUNDED_MESSAGE =
  `The app under automation (${BUNDLE_ID}) is backgrounded; the screen is showing ` +
  "something else. Use screenshot for the current screen, launch-app to bring the " +
  "app back, or launch-app com.apple.springboard to describe the home screen and " +
  "system UI.";

// A registry whose runner answers every snapshot the way the runner now
// answers one for a backgrounded target.
function backgroundedRegistry(): Registry {
  const api = {
    udid: UDID,
    run: vi.fn().mockRejectedValue(
      new RunnerCommandError(`app '${BUNDLE_ID}' is running in the background`, {
        code: "APP_BACKGROUNDED",
      })
    ),
  };
  return { resolveService: vi.fn(async () => api) } as unknown as Registry;
}

beforeEach(() => {
  // The wait tools' iOS branch probes for xcrun; prime so no test shells out.
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun"]);
  clearCurrentIosDeviceApp(UDID);
  setCurrentIosDeviceApp(UDID, BUNDLE_ID);
});

describe("describe (ios-device) on a backgrounded target", () => {
  it("fails with the actionable observation error", async () => {
    const error = await describeIosDevice(backgroundedRegistry(), DEVICE).catch(
      (caught: unknown) => caught
    );

    expect((error as Error).message).toBe(BACKGROUNDED_MESSAGE);
  });
});

describe("await-ui-element on a backgrounded target", () => {
  it("reports the unreadable shape naming the cause, never a raw throw", async () => {
    const tool = createAwaitUiElementTool(backgroundedRegistry());

    const result = await tool.execute(
      {},
      {
        udid: UDID,
        condition: "exists",
        selector: { text: "Settings" },
        timeoutMs: 400,
        pollIntervalMs: 100,
      }
    );

    expect(result.success).toBe(false);
    expect(result.cause).toBe("unreadable");
    expect(result.note).toBe(`last tree fetch failed: ${BACKGROUNDED_MESSAGE}`);
  });
});

describe("await-screen-idle on a backgrounded target", () => {
  it("resolves not-settled instead of throwing, so a caller's screenshot still runs", async () => {
    const tool = createAwaitScreenIdleTool(backgroundedRegistry());

    const result = await tool.execute({}, { udid: UDID, timeoutMs: 400, pollIntervalMs: 100 });

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(0);
  });
});

describe("flow tree read on a backgrounded target", () => {
  it("fails the step with the actionable message rather than an empty tree", async () => {
    const error = await queryIosDeviceFlowTree(backgroundedRegistry(), DEVICE).catch(
      (caught: unknown) => caught
    );

    expect((error as Error).message).toBe(BACKGROUNDED_MESSAGE);
  });
});

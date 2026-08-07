import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  // isAndroidTv shells out; this suite is not about TV detection.
  adbShell: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

import { describeAndroid } from "../src/tools/describe/platforms/android";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";

const SERIAL = "emulator-5554";

/**
 * Counts taken from a Pixel_9 emulator, API 36:
 *   app visible   nodeCount 62, 2 rendered children
 *   launcher      nodeCount 64, 7 rendered children
 *   screen off    nodeCount 28, 0 rendered children
 *   keyguard      nodeCount 73, 0 rendered children
 * The system-chrome XML below is what the last two look like: real nodes, all
 * belonging to com.android.systemui, so all pruned.
 */
const SYSTEM_CHROME_XML = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][1080,2400]"><node class="android.view.View" package="com.android.systemui" bounds="[0,0][1080,120]" /></node></hierarchy>`;

const APP_XML = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][1080,2400]"><node class="android.widget.TextView" package="com.example.app" text="Sign in" bounds="[100,200][500,260]" /></node></hierarchy>`;

function registryFor(xml: string, nodeCount: number | undefined) {
  const android = {
    getHierarchy: async () => ({
      xml,
      ...(nodeCount === undefined ? {} : { nodeCount }),
      windowCount: 1,
      captureMode: "interactive-windows",
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;

  return {
    resolveService: async () => android,
  } as unknown as Parameters<typeof describeAndroid>[0];
}

describe("describeAndroid — blind reads (display off / lock screen)", () => {
  it("flags a tree whose every node was system chrome", async () => {
    // The reported case: the screen is off, so the only window is the system
    // UI, everything prunes away, and the tree looks identical to an empty app.
    const data = await describeAndroid(
      registryFor(SYSTEM_CHROME_XML, 28),
      SERIAL,
      undefined,
      false
    );

    expect(data.tree.children).toHaveLength(0);
    expect(data.hint).toBeDefined();
    expect(data.hint).toContain("BLIND, not empty");
  });

  it("tells the caller what to do about it", async () => {
    const data = await describeAndroid(
      registryFor(SYSTEM_CHROME_XML, 73),
      SERIAL,
      undefined,
      false
    );

    expect(data.hint).toContain("power");
    expect(data.hint).toContain("lock screen");
    // The distinction the whole fix exists for.
    expect(data.hint).toContain("NOT evidence that it is hidden or gone");
  });

  it("says nothing about a screen that really has content", async () => {
    const data = await describeAndroid(registryFor(APP_XML, 62), SERIAL, undefined, false);

    expect(data.tree.children.length).toBeGreaterThan(0);
    expect(data.hint).toBeUndefined();
  });

  it("fails open when the helper reports no node count", async () => {
    // An older device helper does not send one. Guessing "blind" there would
    // mark every sparse screen unreadable, which is worse than the bug.
    const data = await describeAndroid(
      registryFor(SYSTEM_CHROME_XML, undefined),
      SERIAL,
      undefined,
      false
    );

    expect(data.hint).toBeUndefined();
  });

  it("fails open when the accessibility layer handed over nothing at all", async () => {
    // nodeCount 0 is a genuinely empty capture, not a screen full of chrome —
    // there is no evidence of a blind read to report.
    const data = await describeAndroid(
      registryFor(`<hierarchy rotation="0" />`, 0),
      SERIAL,
      undefined,
      false
    );

    expect(data.hint).toBeUndefined();
  });

  it("keeps the Android TV hint alongside it", async () => {
    const data = await describeAndroid(registryFor(SYSTEM_CHROME_XML, 28), SERIAL, undefined, true);

    expect(data.hint).toContain("leanback");
    expect(data.hint).toContain("BLIND, not empty");
  });
});

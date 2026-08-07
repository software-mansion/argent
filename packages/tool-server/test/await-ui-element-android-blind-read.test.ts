import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";

const SERIAL = "emulator-5554";

/** What a powered-off display looks like: real nodes, all system chrome. */
const SYSTEM_CHROME_XML = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][1080,2400]"><node class="android.view.View" package="com.android.systemui" bounds="[0,0][1080,120]" /></node></hierarchy>`;

function registryWith(xml: string, nodeCount: number) {
  const android = {
    getHierarchy: async () => ({ xml, nodeCount, windowCount: 1 }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;
  return {
    resolveService: async () => android,
  } as never;
}

describe("await-ui-element — a blind Android read cannot confirm `hidden`", () => {
  it("does not report an element hidden when the screen could not be read", async () => {
    // Measured on a device: with the display off, `await-ui-element hidden`
    // returned success in 5ms for an element that was still on the screen —
    // the same element `visible` had matched moments earlier. An agent gating
    // an action on "the dialog is gone" got a green light against a screen
    // nobody could see.
    const tool = createAwaitUiElementTool(registryWith(SYSTEM_CHROME_XML, 28));

    const result = await tool.execute(
      {},
      {
        udid: SERIAL,
        condition: "hidden",
        selector: { text: "Go to home screen" },
        timeoutMs: 300,
        pollIntervalMs: 50,
      }
    );

    expect(result.success).toBe(false);
  });

  it("says the read was blind rather than blaming the selector", async () => {
    const tool = createAwaitUiElementTool(registryWith(SYSTEM_CHROME_XML, 73));

    const result = await tool.execute(
      {},
      {
        udid: SERIAL,
        condition: "hidden",
        selector: { text: "Go to home screen" },
        timeoutMs: 300,
        pollIntervalMs: 50,
      }
    );

    expect(result.note).toContain("BLIND, not empty");
  });
});

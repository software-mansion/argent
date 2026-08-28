// The android-devtools helper walks at most `maxNodes` accessibility nodes and
// reports whether it stopped early. A truncated capture is indistinguishable
// from a complete one once it has been rendered as text, so `describe` has to
// say when the tree is partial — a WebView's web DOM can spend the whole budget
// on a single page.
import { describe, it, expect, vi } from "vitest";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";
import type { Registry } from "@argent/registry";

const SERIAL = "emulator-5554";
const XML =
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
  `<node text="Sign in" class="android.widget.Button" clickable="true" bounds="[100,200][980,320]" />` +
  `</node></hierarchy>`;

function registryWith(truncated: boolean): Registry {
  const android: AndroidDevtoolsApi = {
    getHierarchy: async () => ({
      xml: XML,
      captureMode: "helper",
      windowCount: 1,
      nodeCount: 5000,
      truncated,
      elapsedMs: 1,
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AndroidDevtools:")) return android;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as unknown as Registry;
}

describe("describeAndroid — partial capture", () => {
  it("tells the agent when the helper stopped at its node budget", async () => {
    const data = await describeAndroid(registryWith(true), SERIAL, undefined, false);
    expect(data.source).toBe("android-devtools");
    expect(data.hint).toContain("PARTIAL");
    // The tree it did capture is still returned — a partial read beats none.
    expect(data.tree.children.length).toBeGreaterThan(0);
  });

  it("stays silent when the whole screen fit in the capture", async () => {
    const data = await describeAndroid(registryWith(false), SERIAL, undefined, false);
    expect(data.hint).toBeUndefined();
  });
});

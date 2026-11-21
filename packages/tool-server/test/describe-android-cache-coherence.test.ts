import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { AndroidDevtoolsApi, GetHierarchyOptions } from "../src/blueprints/android-devtools";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, isAndroidTv: async () => false };
});

const ANDROID_SERIAL = "emulator-5554";

const XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
  `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" ` +
  `clickable="true" bounds="[100,200][980,320]" />` +
  `</node>` +
  `</hierarchy>`;

function nodeLabels(node: { label?: string; children?: unknown[] }): string[] {
  const self = node.label ? [node.label] : [];
  const kids = (node.children ?? []) as { label?: string; children?: unknown[] }[];
  return [...self, ...kids.flatMap(nodeLabels)];
}

/** Serves `captures` in order (last one repeated) and records each call's options. */
function makeRecordingRegistry(captures: string[] = [XML]) {
  const optionsSeen: (GetHierarchyOptions | undefined)[] = [];
  const android = {
    isReady: () => true,
    getHierarchy: vi.fn(async (opts?: GetHierarchyOptions) => {
      optionsSeen.push(opts);
      return { xml: captures.length > 1 ? captures.shift()! : captures[0]! };
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;
  const registry = {
    resolveService: vi.fn(async () => android),
  } as unknown as Registry;
  return { registry, optionsSeen };
}

function expectAllUncached(seen: (GetHierarchyOptions | undefined)[]): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const opts of seen) expect(opts?.clearCache).toBe(true);
}

describe("Android describe reads bypass the helper's node cache", () => {
  it("describeAndroid requests an uncached capture", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    const result = await describeAndroid(registry, ANDROID_SERIAL, undefined, false);

    expect(optionsSeen).toHaveLength(1);
    expectAllUncached(optionsSeen);
    expect(nodeLabels(result.tree)).toContain("Sign in");
  });

  it("describeAndroid re-reads an unpublished WebView uncached", async () => {
    const cold =
      `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">` +
      `<node class="android.widget.FrameLayout" content-desc="Web View" bounds="[0,0][1080,2400]"/>` +
      `</hierarchy>`;
    const { registry, optionsSeen } = makeRecordingRegistry([cold, XML]);

    const result = await describeAndroid(registry, ANDROID_SERIAL, undefined, false);

    expect(optionsSeen).toHaveLength(2);
    expectAllUncached(optionsSeen);
    expect(nodeLabels(result.tree)).toContain("Sign in");
  });

  it("await-screen-idle polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      await createAwaitScreenIdleTool(registry).execute(
        {},
        { udid: ANDROID_SERIAL, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 50 }
      );
    } finally {
      __resetDepCacheForTests();
    }

    expect(optionsSeen.length).toBeGreaterThan(1);
    expectAllUncached(optionsSeen);
  });

  it("await-ui-element polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      await createAwaitUiElementTool(registry).execute(
        {},
        {
          udid: ANDROID_SERIAL,
          condition: "visible",
          selector: { text: "Nonexistent" },
          timeoutMs: 100,
          pollIntervalMs: 10,
        }
      );
    } finally {
      __resetDepCacheForTests();
    }

    expect(optionsSeen.length).toBeGreaterThan(1);
    expectAllUncached(optionsSeen);
  });
});

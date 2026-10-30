import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../src/tools/describe/contract";
import { waitForScreenIdle, type ScreenIdleWait } from "../src/tools/await-screen-idle";
import { describeChromium } from "../src/tools/describe/platforms/chromium";
import {
  describeAndroid,
  describeAndroidWithHelper,
} from "../src/tools/describe/platforms/android";
import { resolveDevice } from "../src/utils/device-info";
import { isAndroidTv } from "../src/utils/adb";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

vi.mock("../src/tools/describe/platforms/chromium", () => ({ describeChromium: vi.fn() }));
vi.mock("../src/tools/describe/platforms/android", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/describe/platforms/android")>()),
  describeAndroid: vi.fn(),
  describeAndroidWithHelper: vi.fn(),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv: vi.fn(async () => false),
}));

const CHROMIUM = resolveDevice("chromium-cdp-9222");
const ANDROID = resolveDevice("emulator-5554");
const cdp = { marker: "cdp" };
const WAIT: ScreenIdleWait = { timeoutMs: 500, pollIntervalMs: 5, minStableMs: 10 };

function node(children: DescribeNode[] = []): DescribeNode {
  return { role: "group", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

function treeOf(root: DescribeNode): DescribeTreeData {
  return { tree: root, source: "cdp-dom" };
}

const content = treeOf(node([node()]));
const empty = treeOf(node());

function registry(): Registry {
  return { resolveService: vi.fn(async () => cdp) } as unknown as Registry;
}

const chromiumRead = vi.mocked(describeChromium);

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["adb"]);
  chromiumRead.mockReset().mockResolvedValue(content);
  vi.mocked(describeAndroid).mockReset().mockResolvedValue(content);
  vi.mocked(describeAndroidWithHelper).mockReset().mockResolvedValue(content);
  vi.mocked(isAndroidTv).mockClear();
});

describe("waitForScreenIdle", () => {
  it("resolves the Chromium target itself when the caller passes none", async () => {
    const outcome = await waitForScreenIdle(registry(), CHROMIUM, WAIT);

    expect(outcome.settled).toBe(true);
    expect(chromiumRead).toHaveBeenCalledWith(cdp);
  });

  it("ends on the first failed read with stopOnReadError and reports the error", async () => {
    chromiumRead.mockRejectedValue(new Error("Target closed"));

    const outcome = await waitForScreenIdle(registry(), CHROMIUM, {
      ...WAIT,
      stopOnReadError: true,
    });

    expect(outcome).toMatchObject({ settled: false, polls: 1, readError: "Target closed" });
  });

  it("keeps reading after a failed read without stopOnReadError", async () => {
    chromiumRead.mockRejectedValueOnce(new Error("Target closed"));

    const outcome = await waitForScreenIdle(registry(), CHROMIUM, WAIT);

    expect(outcome.settled).toBe(true);
    expect(outcome.readError).toBeUndefined();
  });

  it("honours the abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await waitForScreenIdle(registry(), CHROMIUM, {
      ...WAIT,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ settled: false, aborted: true });
  });

  it("settles on an unchanging empty tree only with emptyTreeIsStable", async () => {
    chromiumRead.mockResolvedValue(empty);

    const strict = await waitForScreenIdle(registry(), CHROMIUM, { ...WAIT, timeoutMs: 100 });
    const lenient = await waitForScreenIdle(registry(), CHROMIUM, {
      ...WAIT,
      emptyTreeIsStable: true,
    });

    expect(strict.settled).toBe(false);
    expect(lenient.settled).toBe(true);
  });

  it("reads Android through the helper alone with androidHelperOnly", async () => {
    await waitForScreenIdle(registry(), ANDROID, { ...WAIT, androidHelperOnly: true });

    expect(describeAndroidWithHelper).toHaveBeenCalled();
    expect(describeAndroid).not.toHaveBeenCalled();
  });

  it("skips the Android TV probe with androidHelperOnly, whose read takes no TV hint", async () => {
    await waitForScreenIdle(registry(), ANDROID, { ...WAIT, androidHelperOnly: true });
    expect(isAndroidTv).not.toHaveBeenCalled();

    await waitForScreenIdle(registry(), ANDROID, WAIT);
    expect(isAndroidTv).toHaveBeenCalledWith(ANDROID.id);
  });
});

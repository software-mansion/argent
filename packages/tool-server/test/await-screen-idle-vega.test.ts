import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchVegaPageSource = vi.fn();
vi.mock("../src/utils/vega-inspect", () => ({
  fetchVegaPageSource: (...a: unknown[]) => fetchVegaPageSource(...a),
}));

let adbInstalled = true;
vi.mock("../src/utils/android-binary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-binary")>();
  return {
    ...actual,
    resolveAndroidBinary: async () => (adbInstalled ? "/usr/bin/adb" : null),
  };
});

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import {
  DependencyMissingError,
  __primeDepCacheForTests,
  __resetDepCacheForTests,
} from "../src/utils/check-deps";

const PAGE_SOURCE = readFileSync(join(__dirname, "fixtures", "vega-page-source.xml"), "utf8");
const VEGA_SERIAL = "amazon-4e311aa3932a35be";

describe("await-screen-idle on Vega", () => {
  beforeEach(() => {
    fetchVegaPageSource.mockReset();
    adbInstalled = true;
    __resetDepCacheForTests();
    __primeDepCacheForTests(["adb"]);
  });

  it("settles by polling the Vega automation toolkit", async () => {
    fetchVegaPageSource.mockResolvedValue(PAGE_SOURCE);
    const tool = createAwaitScreenIdleTool({} as any);

    const result = await tool.execute(
      {},
      { udid: VEGA_SERIAL, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(true);
    expect(result.polls).toBeGreaterThan(1);
    expect(fetchVegaPageSource).toHaveBeenCalledTimes(result.polls);
  });

  it("does not settle while the page source keeps changing", async () => {
    const moved = PAGE_SOURCE.replace("<text>Libraries</text>", "<text>Loading</text>");
    expect(moved).not.toBe(PAGE_SOURCE);
    let call = 0;
    fetchVegaPageSource.mockImplementation(async () => (call++ % 2 ? moved : PAGE_SOURCE));
    const tool = createAwaitScreenIdleTool({} as any);

    const result = await tool.execute(
      {},
      { udid: VEGA_SERIAL, timeoutMs: 150, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(2);
  });

  it("does not settle while the toolkit is unreachable", async () => {
    fetchVegaPageSource.mockRejectedValue(new Error("ECONNREFUSED"));
    const tool = createAwaitScreenIdleTool({} as any);

    const result = await tool.execute(
      {},
      { udid: VEGA_SERIAL, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(false);
  });

  it("fails fast with the adb install hint when adb is missing", async () => {
    __resetDepCacheForTests();
    adbInstalled = false;
    const tool = createAwaitScreenIdleTool({} as any);

    await expect(
      tool.execute({}, { udid: VEGA_SERIAL, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 20 })
    ).rejects.toBeInstanceOf(DependencyMissingError);
    expect(fetchVegaPageSource).not.toHaveBeenCalled();
  });
});

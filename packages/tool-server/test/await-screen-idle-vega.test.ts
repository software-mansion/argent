import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchVegaPageSource = vi.fn();
vi.mock("../src/utils/vega-inspect", () => ({
  fetchVegaPageSource: (...a: unknown[]) => fetchVegaPageSource(...a),
}));

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const PAGE_SOURCE = readFileSync(join(__dirname, "fixtures", "vega-page-source.xml"), "utf8");
const VEGA_SERIAL = "amazon-4e311aa3932a35be";

describe("await-screen-idle on Vega", () => {
  beforeEach(() => {
    fetchVegaPageSource.mockReset();
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

  it("does not settle while the toolkit is unreachable", async () => {
    fetchVegaPageSource.mockRejectedValue(new Error("ECONNREFUSED"));
    const tool = createAwaitScreenIdleTool({} as any);

    const result = await tool.execute(
      {},
      { udid: VEGA_SERIAL, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(false);
  });
});

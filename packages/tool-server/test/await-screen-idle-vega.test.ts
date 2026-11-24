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

import { FAILURE_CODES, FailureError } from "@argent/registry";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { MultipleVegaDevicesError } from "../src/utils/vega-vvd";
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

  it.each([
    [
      "selected",
      PAGE_SOURCE.replace(
        'id="163208757260" selectable="true" selected="true"',
        'id="163208757260" selectable="true" selected="false"'
      ).replace(
        'id="163208757263" selectable="true" selected="false"',
        'id="163208757263" selectable="true" selected="true"'
      ),
    ],
    [
      "focused",
      PAGE_SOURCE.replace(
        'id="163208757263" selectable="true" selected="false" focusable="true" focused="false"',
        'id="163208757263" selectable="true" selected="false" focusable="true" focused="true"'
      ),
    ],
  ])("does not settle while the D-pad cursor is still moving (%s)", async (_attr, moved) => {
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

  it("names the missing VVD instead of advising a relaunch", async () => {
    fetchVegaPageSource.mockRejectedValue(
      new FailureError("No running Vega Virtual Device found.", {
        error_code: FAILURE_CODES.VEGA_DEVICE_NOT_FOUND,
        failure_stage: "vega_discover_console_port",
        failure_area: "tool_server",
        error_kind: "not_found",
      })
    );
    const tool = createAwaitScreenIdleTool({} as any);

    const result = await tool.execute(
      {},
      { udid: VEGA_SERIAL, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 20 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toContain("No running Vega Virtual Device found.");
    expect(result.note).not.toMatch(/relaunch/);
  });

  it("fails on the first read when several VVDs run, since waiting cannot pick one", async () => {
    fetchVegaPageSource.mockRejectedValue(new MultipleVegaDevicesError([5554, 5556]));
    const tool = createAwaitScreenIdleTool({} as any);

    await expect(
      tool.execute({}, { udid: VEGA_SERIAL, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 20 })
    ).rejects.toBeInstanceOf(MultipleVegaDevicesError);
    expect(fetchVegaPageSource).toHaveBeenCalledTimes(1);
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

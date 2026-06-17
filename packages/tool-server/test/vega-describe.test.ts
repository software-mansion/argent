import { describe, it, expect, vi, beforeEach } from "vitest";

// describeVega fetches the page source from the on-device toolkit; mock that so
// we can drive its failure handling deterministically.
const fetchVegaPageSource = vi.fn();
vi.mock("../src/utils/vega-inspect", () => ({
  fetchVegaPageSource: (...a: unknown[]) => fetchVegaPageSource(...a),
}));

import { describeVega } from "../src/tools/describe/platforms/vega";
import { MultipleVegaDevicesError } from "../src/utils/vega-vvd";

beforeEach(() => {
  fetchVegaPageSource.mockReset();
});

describe("describeVega failure handling", () => {
  it("rethrows the multi-VVD ambiguity error instead of burying it in the relaunch hint", async () => {
    fetchVegaPageSource.mockRejectedValue(
      new MultipleVegaDevicesError(["/tmp/qmp-socket-5554.sock", "/tmp/qmp-socket-5556.sock"])
    );
    await expect(describeVega("amazon-abc")).rejects.toBeInstanceOf(MultipleVegaDevicesError);
  });

  it("returns an empty tree + relaunch hint when the toolkit is unreachable", async () => {
    fetchVegaPageSource.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await describeVega("amazon-abc");
    expect(out.source).toBe("vega-automation");
    expect(out.tree.children).toEqual([]);
    expect(out.hint).toMatch(/relaunch the foreground app/i);
  });
});

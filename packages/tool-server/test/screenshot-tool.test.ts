import { afterEach, describe, expect, it, vi } from "vitest";
import { screenshotTool } from "../src/tools/screenshot";

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves includeImageInContext in the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "http://localhost/screenshot.png",
          path: "/tmp/screenshot.png",
        }),
      })
    );

    const params = screenshotTool.zodSchema!.parse({
      udid: "ABC",
      includeImageInContext: false,
    });
    const result = await screenshotTool.execute(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      params,
      {}
    );

    expect(result).toEqual({
      url: "http://localhost/screenshot.png",
      path: "/tmp/screenshot.png",
      includeImageInContext: false,
    });
  });
});

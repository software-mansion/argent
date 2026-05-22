import { afterEach, describe, expect, it, vi } from "vitest";
import { screenshotTool } from "../src/tools/screenshot";

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only url and path; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
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

    const params = {
      udid: "ABC",
      includeImageInContext: false,
    };
    screenshotTool.zodSchema!.parse(params);

    const result = await screenshotTool.execute(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      params,
      {}
    );

    expect(result).toEqual({
      url: "http://localhost/screenshot.png",
      path: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { httpScreenshot } from "../src/utils/simulator-client";

function fakeFetch(status: number, json: unknown) {
  return vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
      }) as unknown as Response
  );
}

const api = { apiUrl: "http://127.0.0.1:4949" } as never;

describe("httpScreenshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the server's error message when a 200 response carries { error } and no url/path", async () => {
    // The Android simulator-server reports a full-resolution framebuffer
    // mismatch as HTTP 200 + { error }, not a non-2xx status. The real cause
    // must reach the caller, not the misleading "restart the server" hint.
    vi.stubGlobal(
      "fetch",
      fakeFetch(200, { error: "wrong data size, expected 7853760 got 17627328" })
    );
    await expect(httpScreenshot(api)).rejects.toThrow(
      "Screenshot failed: wrong data size, expected 7853760 got 17627328."
    );
  });

  it("uses the generic hint only when url/path are missing AND there is no error field", async () => {
    vi.stubGlobal("fetch", fakeFetch(200, {}));
    await expect(httpScreenshot(api)).rejects.toThrow("server response missing url or path");
  });

  it("returns url and path on a successful capture", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch(200, { url: "http://127.0.0.1:4949/media/x.png", path: "/tmp/x.png" })
    );
    await expect(httpScreenshot(api)).resolves.toEqual({
      url: "http://127.0.0.1:4949/media/x.png",
      path: "/tmp/x.png",
    });
  });
});

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

  it("retries 'no image to export' until the first frame lands, then resolves", async () => {
    // A freshly-spawned simulator-server has not captured its first frame yet,
    // so the streaming screenshot endpoint replies 200 { error: "no image to
    // export" } for ~0.5-1s. The capture must poll past that rather than fail
    // (regression #391: reliably hit with >1 booted simulator).
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          const json =
            calls < 3
              ? { error: "no image to export" }
              : { url: "http://127.0.0.1:4949/media/x.png", path: "/tmp/x.png" };
          return { ok: true, status: 200, json: async () => json } as unknown as Response;
        })
      );
      const pending = httpScreenshot(api);
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toEqual({
        url: "http://127.0.0.1:4949/media/x.png",
        path: "/tmp/x.png",
      });
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with the 'no image to export' message once the first-frame deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ error: "no image to export" }),
          }) as unknown as Response
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = httpScreenshot(api);
      const expectation = expect(pending).rejects.toThrow("Screenshot failed: no image to export.");
      await vi.advanceTimersByTimeAsync(7_000);
      await expectation;
      // Polling is bounded (~6s / 250ms ≈ 24 attempts), never an infinite loop.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(fetchMock.mock.calls.length).toBeLessThan(40);
    } finally {
      vi.useRealTimers();
    }
  });
});

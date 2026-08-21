import { afterEach, describe, expect, it, vi } from "vitest";

import { FailureError } from "@argent/registry";
import { httpAxTree, httpScreenshot } from "../src/utils/simulator-client";

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

  it("classifies a bare null body instead of crashing on it, at 200 and on failure", async () => {
    // A bare `null` parses as JSON, so it gets past the non-JSON guard and then
    // takes every named field read below as an unclassified TypeError — a 500
    // with no error_code, blaming argent for an answer the server got wrong.
    vi.stubGlobal("fetch", fakeFetch(200, null));
    await expect(httpScreenshot(api)).rejects.toThrow(FailureError);
    await expect(httpScreenshot(api)).rejects.toThrow("server response missing url or path");

    vi.stubGlobal("fetch", fakeFetch(500, null));
    await expect(httpScreenshot(api)).rejects.toThrow(FailureError);
    await expect(httpScreenshot(api)).rejects.toThrow("HTTP 500");
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

describe("httpAxTree", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("raises the server's error message instead of reporting an empty screen", async () => {
    // The empty-tree path is indistinguishable from a real read of a blank
    // screen: `describe` would answer "0 elements — the screen may be off or
    // locked" for what was actually an HTTP failure, i.e. success reported for
    // a read that never happened.
    vi.stubGlobal("fetch", fakeFetch(500, { error: "axAudit session not established" }));
    await expect(httpAxTree(api)).rejects.toThrow(/axAudit session not established/);
  });

  it("raises on a 200 that carries { error }, like the screenshot sibling", async () => {
    vi.stubGlobal("fetch", fakeFetch(200, { error: "device is locked" }));
    await expect(httpAxTree(api)).rejects.toThrow(/device is locked/);
  });

  for (const [name, payload] of [
    ["elements as an object", { elements: {} }],
    ["elements as a string", { elements: "str" }],
    ["a null element", { elements: [null] }],
    ["a non-string caption", { elements: [{ caption: 42, id: "a" }] }],
    ["a non-numeric screen width", { elements: [], screen: { w: "abc", h: 852 } }],
    ["a bare null body", null],
    ["a bare array body", []],
  ] as const) {
    it(`rejects ${name} with a classified failure, not a TypeError`, async () => {
      // The adapter indexes `elements` and calls string methods on `caption`.
      // Unvalidated, each of these reaches it and dies as a bare TypeError —
      // a 500 with no error_code, which reads as an argent bug rather than a
      // device that answered out of contract.
      vi.stubGlobal("fetch", fakeFetch(200, payload));
      await expect(httpAxTree(api)).rejects.toThrow(FailureError);
      await expect(httpAxTree(api)).rejects.toThrow(/does not match the expected shape/);
    });
  }

  for (const status of [500, 503] as const) {
    it(`reports HTTP ${status} rather than crashing when the body is a bare null`, async () => {
      // The in-band `{ error }` read happens on the failure path too, so a
      // status-only answer with a null body took the same bare TypeError —
      // on exactly the responses a server that cannot answer sends.
      vi.stubGlobal("fetch", fakeFetch(status, null));
      await expect(httpAxTree(api)).rejects.toThrow(FailureError);
      await expect(httpAxTree(api)).rejects.toThrow(new RegExp(`HTTP ${status}`));
    });
  }

  it("posts to the ax-tree endpoint the sim-server serves", async () => {
    // The single wire path physical-iOS describe has. `fakeFetch` ignores its
    // arguments, so nothing else in the suite would notice the URL changing to
    // one the sim-server does not route — describe would fail on every device
    // with a transport error and no test would say why.
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return { ok: true, status: 200, json: async () => ({ elements: [] }) } as Response;
      })
    );
    await httpAxTree({ apiUrl: "http://sim.test" } as never, 7);
    expect(seen).toEqual([{ url: "http://sim.test/api/ax-tree", body: { limit: 7 } }]);
  });

  for (const [name, payload] of [
    ["a non-string rect", { elements: [{ caption: "a", id: "1", rect: 42 }] }],
    ["a non-numeric screen height", { elements: [], screen: { w: 393, h: "tall" } }],
    ["a non-finite screen dimension", { elements: [], screen: { w: Infinity, h: 852 } }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      // `rect` is the one remaining field the adapter calls a string method on,
      // and a non-finite screen dimension divides every normalized frame into
      // 0 — neither is caught by the caption/width cases above.
      vi.stubGlobal("fetch", fakeFetch(200, payload));
      await expect(httpAxTree(api)).rejects.toThrow(/does not match the expected shape/);
    });
  }

  it("passes a well-formed tree through, defaulting the optional fields", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch(200, { elements: [{ caption: "Wi-Fi, Button", id: "0x1" }], screen: { w: 393 } })
    );
    await expect(httpAxTree(api)).resolves.toEqual({
      elements: [{ caption: "Wi-Fi, Button", id: "0x1" }],
      screen: { w: 393 },
    });
  });
});

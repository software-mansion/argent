import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearCookies,
  clearStorage,
  deleteCookies,
  getCookies,
  getStorageAll,
  getStorageItem,
  removeStorageItem,
  setCookie,
  setStorageItem,
} from "../src/chromium-server/storage";

function fakeCdp(
  reply: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    reply(method, params)
  );
  return { send, cdp: { send } as never };
}

describe("storage helpers — cookies", () => {
  it("getCookies returns the cookies array and forwards urls", async () => {
    const f = fakeCdp(() => ({ cookies: [{ name: "sid", value: "abc" }] }));
    const cookies = await getCookies(f.cdp, ["https://x.test/"]);
    expect(cookies).toEqual([{ name: "sid", value: "abc" }]);
    expect(f.send).toHaveBeenCalledWith("Network.getCookies", { urls: ["https://x.test/"] });
  });

  it("getCookies with no urls sends an empty params object", async () => {
    const f = fakeCdp(() => ({ cookies: [] }));
    await getCookies(f.cdp);
    expect(f.send).toHaveBeenCalledWith("Network.getCookies", {});
  });

  it("setCookie requires url or domain", async () => {
    const f = fakeCdp(() => ({ success: true }));
    await expect(setCookie(f.cdp, { name: "a", value: "b" })).rejects.toThrow(/url.*or.*domain/i);
  });

  it("setCookie returns success and forwards params", async () => {
    const f = fakeCdp(() => ({ success: true }));
    const ok = await setCookie(f.cdp, { name: "sid", value: "abc", url: "https://x.test/" });
    expect(ok).toBe(true);
    expect(f.send).toHaveBeenCalledWith(
      "Network.setCookie",
      expect.objectContaining({ name: "sid", value: "abc", url: "https://x.test/" })
    );
  });

  it("deleteCookies / clearCookies hit the right CDP methods", async () => {
    const f = fakeCdp();
    await deleteCookies(f.cdp, { name: "sid", url: "https://x.test/" });
    expect(f.send).toHaveBeenCalledWith("Network.deleteCookies", {
      name: "sid",
      url: "https://x.test/",
    });
    await clearCookies(f.cdp);
    expect(f.send).toHaveBeenCalledWith("Network.clearBrowserCookies");
  });
});

describe("storage helpers — local/session", () => {
  it("getStorageAll returns the entries object from a returnByValue eval", async () => {
    const f = fakeCdp((m) =>
      m === "Runtime.evaluate" ? { result: { value: { a: "1", b: "2" } } } : {}
    );
    const all = await getStorageAll(f.cdp, "local");
    expect(all).toEqual({ a: "1", b: "2" });
    const [, params] = f.send.mock.calls[0]!;
    expect((params as Record<string, unknown>).expression).toContain("localStorage");
    expect((params as Record<string, unknown>).returnByValue).toBe(true);
  });

  it("getStorageItem returns the value (null when absent)", async () => {
    const f = fakeCdp(() => ({ result: { value: "v" } }));
    expect(await getStorageItem(f.cdp, "session", "k")).toBe("v");
    expect((f.send.mock.calls[0]![1] as Record<string, unknown>).expression).toContain(
      'sessionStorage.getItem("k")'
    );
  });

  it("setStorageItem JSON-encodes key and value into the expression", async () => {
    const f = fakeCdp(() => ({ result: { value: undefined } }));
    await setStorageItem(f.cdp, "local", "tok'en", 'va"lue');
    const expr = (f.send.mock.calls[0]![1] as Record<string, unknown>).expression as string;
    expect(expr).toContain("localStorage.setItem(");
    // key and value are JSON-encoded, so embedded quotes are safely escaped.
    expect(expr).toContain(JSON.stringify("tok'en"));
    expect(expr).toContain(JSON.stringify('va"lue'));
  });

  it("removeStorageItem / clearStorage build the right expressions", async () => {
    const f = fakeCdp(() => ({ result: { value: undefined } }));
    await removeStorageItem(f.cdp, "session", "k");
    expect((f.send.mock.calls[0]![1] as Record<string, unknown>).expression).toBe(
      'sessionStorage.removeItem("k")'
    );
    await clearStorage(f.cdp, "local");
    expect((f.send.mock.calls[1]![1] as Record<string, unknown>).expression).toBe(
      "localStorage.clear()"
    );
  });

  it("eval surfaces exceptionDetails as an error", async () => {
    const f = fakeCdp(() => ({ exceptionDetails: { text: "SecurityError" } }));
    await expect(getStorageAll(f.cdp, "local")).rejects.toThrow(/SecurityError/);
  });
});

// ── Tools ────────────────────────────────────────────────────────────────────
import { chromiumCookiesTool } from "../src/tools/chromium-cookies";
import { chromiumStorageTool } from "../src/tools/chromium-storage";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

const chromium = resolveDevice("chromium-cdp-9222");
const ios = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");

describe("chromium-cookies tool", () => {
  let send: ReturnType<typeof vi.fn>;
  let services: never;
  beforeEach(() => {
    send = vi.fn(async (m: string) =>
      m === "Network.getCookies" ? { cookies: [{ name: "a", value: "b" }] } : { success: true }
    );
    services = { chromium: { cdp: { send } } } as never;
  });

  it("capability is chromium-only", () => {
    expect(() => assertSupported("c", chromiumCookiesTool.capability, chromium)).not.toThrow();
    expect(() => assertSupported("c", chromiumCookiesTool.capability, ios)).toThrow(
      UnsupportedOperationError
    );
  });

  it("get returns cookies; set forwards; delete/clear dispatch", async () => {
    const got = (await chromiumCookiesTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "get",
    })) as { count: number };
    expect(got.count).toBe(1);

    await chromiumCookiesTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "set",
      name: "sid",
      value: "x",
      url: "https://x.test/",
    });
    expect(send).toHaveBeenCalledWith(
      "Network.setCookie",
      expect.objectContaining({ name: "sid", value: "x" })
    );

    await chromiumCookiesTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "clear",
    });
    expect(send).toHaveBeenCalledWith("Network.clearBrowserCookies");
  });

  it("set without name/value throws", async () => {
    await expect(
      chromiumCookiesTool.execute(services, { udid: "chromium-cdp-9222", action: "set", name: "x" })
    ).rejects.toThrow(/requires `name` and `value`/);
  });
});

describe("chromium-storage tool", () => {
  it("capability is chromium-only", () => {
    expect(() => assertSupported("s", chromiumStorageTool.capability, chromium)).not.toThrow();
    expect(() => assertSupported("s", chromiumStorageTool.capability, ios)).toThrow(
      UnsupportedOperationError
    );
  });

  it("get all vs get key, and set/remove/clear", async () => {
    const send = vi.fn(async (_m: string, p?: Record<string, unknown>) => {
      const expr = String(p?.expression ?? "");
      if (expr.includes("for (let i")) return { result: { value: { a: "1" } } };
      if (expr.includes("getItem")) return { result: { value: "1" } };
      return { result: { value: undefined } };
    });
    const services = { chromium: { cdp: { send } } } as never;

    const all = (await chromiumStorageTool.execute(services, {
      udid: "chromium-cdp-9222",
      store: "local",
      action: "get",
    })) as { count: number };
    expect(all.count).toBe(1);

    const one = (await chromiumStorageTool.execute(services, {
      udid: "chromium-cdp-9222",
      store: "session",
      action: "get",
      key: "a",
    })) as { value: string | null };
    expect(one.value).toBe("1");

    await chromiumStorageTool.execute(services, {
      udid: "chromium-cdp-9222",
      store: "local",
      action: "set",
      key: "a",
      value: "2",
    });
    expect(send.mock.calls.some((c) => String(c[1]?.expression).includes("setItem"))).toBe(true);
  });

  it("set without key/value throws", async () => {
    const services = { chromium: { cdp: { send: vi.fn() } } } as never;
    await expect(
      chromiumStorageTool.execute(services, {
        udid: "chromium-cdp-9222",
        store: "local",
        action: "set",
        key: "a",
      })
    ).rejects.toThrow(/requires `key` and `value`/);
  });
});

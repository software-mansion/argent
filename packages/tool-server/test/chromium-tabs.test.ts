import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the CDP-session HTTP helpers tabs.ts depends on ─────────────────────
vi.mock("../src/chromium-server/cdp-session", () => ({
  listPageTargets: vi.fn(),
  browserWebSocketUrl: vi.fn(async () => "ws://127.0.0.1:9222/devtools/browser/x"),
}));

// ── Mock the transient browser CDPClient used for create/close ───────────────
const browserSend = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
  if (method === "Target.createTarget") return { targetId: "TID-NEW" };
  return {};
});
vi.mock("../src/utils/debugger/cdp-client", () => ({
  // A class so `new CDPClient(...)` works; methods delegate to the shared spy.
  CDPClient: class {
    connect() {
      return Promise.resolve();
    }
    send(method: string, params?: Record<string, unknown>) {
      return browserSend(method, params);
    }
    disconnect() {
      return Promise.resolve();
    }
  },
}));

import { createTabsManager } from "../src/chromium-server/tabs";
import { listPageTargets } from "../src/chromium-server/cdp-session";

const listMock = listPageTargets as unknown as ReturnType<typeof vi.fn>;

function tgt(id: string) {
  return {
    id,
    type: "page",
    title: `Title ${id}`,
    url: `https://${id}.test/`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

describe("TabsManager", () => {
  let cdp: { reconnect: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  let onActivated: ReturnType<typeof vi.fn>;
  let throttled: boolean;
  let mgr: ReturnType<typeof createTabsManager>;

  beforeEach(() => {
    browserSend.mockClear();
    listMock.mockReset();
    cdp = { reconnect: vi.fn(async () => {}), send: vi.fn(async () => ({})) };
    onActivated = vi.fn(async () => {});
    throttled = true;
    mgr = createTabsManager({
      cdp: cdp as never,
      port: 9222,
      initialTargetId: "A",
      onActivated: onActivated as never,
      networkThrottled: () => throttled,
    });
  });

  it("list() assigns stable t1/t2 ids and marks the active tab", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("B")]);
    const tabs = await mgr.list();
    expect(tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
    expect(tabs.find((t) => t.targetId === "A")!.active).toBe(true);
    expect(tabs.find((t) => t.targetId === "B")!.active).toBe(false);

    // ids are stable across calls (B stays t2 even though A is listed first).
    const again = await mgr.list();
    expect(again.find((t) => t.targetId === "B")!.tabId).toBe("t2");
  });

  it("select() re-points cdp to the target's ws, re-primes, and sets active", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("B")]);
    await mgr.list();
    const tabs = await mgr.select("t2");
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/B");
    expect(onActivated).toHaveBeenCalledOnce();
    expect(mgr.activeTargetId()).toBe("B");
    expect(tabs.find((t) => t.targetId === "B")!.active).toBe(true);
  });

  it("select() of the already-active tab is a no-op (no reconnect)", async () => {
    listMock.mockResolvedValue([tgt("A")]);
    await mgr.list();
    await mgr.select("t1");
    expect(cdp.reconnect).not.toHaveBeenCalled();
  });

  it("select() resolves a label to its tab", async () => {
    // open assigns label "docs" to the created target, then select by label.
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    await mgr.open({ label: "docs" }); // activates TID-NEW
    cdp.reconnect.mockClear();
    await mgr.select("A" /* raw target id also works */);
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/A");
    cdp.reconnect.mockClear();
    await mgr.select("docs");
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/TID-NEW");
  });

  it("open() creates a target via Target.createTarget, activates it, applies label", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    const tabs = await mgr.open({ url: "https://x.test", label: "docs" });
    expect(browserSend).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank" });
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/TID-NEW");
    expect(mgr.activeTargetId()).toBe("TID-NEW");
    const created = tabs.find((t) => t.targetId === "TID-NEW")!;
    expect(created.active).toBe(true);
    expect(created.label).toBe("docs");
  });

  it("open() closes the blank tab Argent opened for a windowless browser", async () => {
    const withPlaceholder = createTabsManager({
      cdp: cdp as never,
      port: 9222,
      initialTargetId: "A",
      placeholderTargetId: "A",
      onActivated: onActivated as never,
      networkThrottled: () => false,
    });
    listMock.mockResolvedValue([{ ...tgt("A"), url: "about:blank" }, tgt("TID-NEW")]);

    await withPlaceholder.open({ url: "https://x.test" });

    expect(browserSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "A" });
  });

  it("open() keeps the placeholder tab once something loaded in it", async () => {
    const withPlaceholder = createTabsManager({
      cdp: cdp as never,
      port: 9222,
      initialTargetId: "A",
      placeholderTargetId: "A",
      onActivated: onActivated as never,
      networkThrottled: () => false,
    });
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);

    await withPlaceholder.open({ url: "https://x.test" });

    expect(browserSend).not.toHaveBeenCalledWith("Target.closeTarget", expect.anything());
  });

  it("open({ activate: false }) keeps the active placeholder for a later open() to close", async () => {
    const withPlaceholder = createTabsManager({
      cdp: cdp as never,
      port: 9222,
      initialTargetId: "A",
      placeholderTargetId: "A",
      onActivated: onActivated as never,
      networkThrottled: () => false,
    });
    listMock.mockResolvedValue([{ ...tgt("A"), url: "about:blank" }, tgt("TID-NEW")]);

    await withPlaceholder.open({ url: "https://x.test", activate: false });
    expect(browserSend).not.toHaveBeenCalledWith("Target.closeTarget", expect.anything());

    await withPlaceholder.open({ url: "https://y.test" });
    expect(browserSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "A" });
  });

  it("open() loads the url only after the new tab's session is prepared", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    const order: string[] = [];
    onActivated.mockImplementation(async () => {
      order.push("activated");
    });
    cdp.send.mockImplementation(async (method: string) => {
      order.push(method);
      return {};
    });

    await mgr.open({ url: "https://x.test" });

    await vi.waitFor(() =>
      expect(order).toEqual(["activated", "Page.navigate", "Page.resetNavigationHistory"])
    );
    expect(cdp.send).toHaveBeenCalledWith(
      "Page.navigate",
      { url: "https://x.test", transitionType: "typed" },
      expect.any(Number)
    );
  });

  it("open() retries the history reset until the load has committed", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    const reset = vi
      .fn()
      .mockRejectedValueOnce(new Error("Not attached to an active page"))
      .mockResolvedValue({});
    cdp.send.mockImplementation(async (method: string) =>
      method === "Page.resetNavigationHistory" ? reset() : {}
    );

    await mgr.open({ url: "https://x.test" });

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(2));
  });

  it("open() returns without waiting for the page to answer", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    cdp.send.mockImplementation(() => new Promise(() => {}));

    await expect(mgr.open({ url: "https://x.test" })).resolves.toBeDefined();
  });

  it.each(["", "about:blank"])(
    "open() reports the requested url for a tab still listed at %j",
    async (listedUrl) => {
      listMock.mockResolvedValue([
        tgt("A"),
        { ...tgt("TID-NEW"), title: "about:blank", url: listedUrl },
      ]);

      const tabs = await mgr.open({ url: "https://x.test" });

      expect(tabs.find((t) => t.targetId === "TID-NEW")!.url).toBe("https://x.test");
    }
  );

  it("open() hands a url that loads no network page straight to the new tab", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);

    await mgr.open({ url: "file:///tmp/index.html" });

    expect(browserSend).toHaveBeenCalledWith("Target.createTarget", {
      url: "file:///tmp/index.html",
    });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("open() hands the url straight to the new tab while no network conditions are set", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);
    throttled = false;

    await mgr.open({ url: "https://x.test" });

    expect(browserSend).toHaveBeenCalledWith("Target.createTarget", { url: "https://x.test" });
    expect(cdp.send).not.toHaveBeenCalled();
    expect(mgr.activeTargetId()).toBe("TID-NEW");
  });

  it("open() hands the url to a tab it does not activate", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("TID-NEW")]);

    await mgr.open({ url: "https://x.test", activate: false });

    expect(browserSend).toHaveBeenCalledWith("Target.createTarget", { url: "https://x.test" });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("open() explains an Electron refusal instead of passing its bare error through", async () => {
    // Electron answers Target.createTarget with a bare "Not supported", which
    // reads as though the whole tool were unavailable.
    browserSend.mockRejectedValueOnce(new Error("Not supported"));

    const err = await mgr.open({ url: "https://x.test" }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // The cause is kept, so a different failure stays legible...
    expect(message).toContain("Not supported");
    // ...alongside what is actually unavailable, why, and what to do instead.
    expect(message).toContain("Electron");
    expect(message).toContain("window.open()");
    expect(message).toContain("chromium-tabs list");
    // And that the rest of the tool still works, which the bare error hid.
    expect(message).toMatch(/list, select and close/);
  });

  it("close() closes the target and re-activates a remaining tab when the active one closed", async () => {
    // active is "A" (initialTargetId). Close it; fall back to "B".
    listMock
      .mockResolvedValueOnce([tgt("A"), tgt("B")]) // initial list() to assign ids
      .mockResolvedValueOnce([tgt("A"), tgt("B")]) // close(): resolve ref
      .mockResolvedValue([tgt("B")]); // final list()
    const order: string[] = [];
    cdp.reconnect.mockImplementation(async (url: string) => {
      order.push(`reconnect ${url}`);
    });
    browserSend.mockImplementationOnce(async (method: string) => {
      order.push(method);
      return {};
    });
    await mgr.list();
    const tabs = await mgr.close("t1");
    expect(order).toEqual(["reconnect ws://127.0.0.1:9222/devtools/page/B", "Target.closeTarget"]);
    expect(browserSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "A" });
    expect(mgr.activeTargetId()).toBe("B");
    expect(tabs.map((t) => t.targetId)).toEqual(["B"]);
  });

  it("close() leaves out a closed tab that Chrome still lists", async () => {
    listMock.mockResolvedValue([tgt("A"), tgt("B")]);
    await mgr.list();
    const tabs = await mgr.close("t2");
    expect(tabs.map((t) => t.tabId)).toEqual(["t1"]);
  });

  it("close() falls back to a tab it can attach to", async () => {
    const detached = { ...tgt("B"), webSocketDebuggerUrl: undefined };
    listMock.mockResolvedValue([tgt("A"), detached, tgt("C")]);

    await mgr.close();

    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/C");
    expect(browserSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "A" });
  });
});

// ── Tool: capability gate + action dispatch ──────────────────────────────────
import { chromiumTabsTool } from "../src/tools/chromium-tabs";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

describe("chromium-tabs tool", () => {
  it("capability accepts chromium and rejects iOS/Android", () => {
    const chromium = resolveDevice("chromium-cdp-9222");
    const ios = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    const android = resolveDevice("emulator-5554");
    expect(() =>
      assertSupported("chromium-tabs", chromiumTabsTool.capability, chromium)
    ).not.toThrow();
    expect(() => assertSupported("chromium-tabs", chromiumTabsTool.capability, ios)).toThrow(
      UnsupportedOperationError
    );
    expect(() => assertSupported("chromium-tabs", chromiumTabsTool.capability, android)).toThrow(
      UnsupportedOperationError
    );
  });

  it("dispatches each action to the matching TabsManager method", async () => {
    const tabsApi = {
      list: vi.fn(async () => [{ tabId: "t1", targetId: "A", title: "", url: "", active: true }]),
      select: vi.fn(async () => []),
      open: vi.fn(async () => []),
      close: vi.fn(async () => []),
      activeTargetId: () => "A",
    };
    const services = { chromium: { server: { tabs: tabsApi } } } as never;

    await chromiumTabsTool.execute(services, { udid: "chromium-cdp-9222", action: "list" });
    expect(tabsApi.list).toHaveBeenCalledOnce();

    await chromiumTabsTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "select",
      tab: "t2",
    });
    expect(tabsApi.select).toHaveBeenCalledWith("t2");

    await chromiumTabsTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "new",
      url: "https://x.test",
      label: "docs",
    });
    expect(tabsApi.open).toHaveBeenCalledWith({ url: "https://x.test", label: "docs" });

    await chromiumTabsTool.execute(services, {
      udid: "chromium-cdp-9222",
      action: "close",
      tab: "t1",
    });
    expect(tabsApi.close).toHaveBeenCalledWith("t1");
  });

  it("select without a tab throws a helpful error", async () => {
    const services = { chromium: { server: { tabs: {} } } } as never;
    await expect(
      chromiumTabsTool.execute(services, { udid: "chromium-cdp-9222", action: "select" })
    ).rejects.toThrow(/requires `tab`/);
  });
});

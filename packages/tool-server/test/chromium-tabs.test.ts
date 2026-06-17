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
  let cdp: { reconnect: ReturnType<typeof vi.fn> };
  let onActivated: ReturnType<typeof vi.fn>;
  let mgr: ReturnType<typeof createTabsManager>;

  beforeEach(() => {
    browserSend.mockClear();
    listMock.mockReset();
    cdp = { reconnect: vi.fn(async () => {}) };
    onActivated = vi.fn(async () => {});
    mgr = createTabsManager({
      cdp: cdp as never,
      port: 9222,
      initialTargetId: "A",
      onActivated: onActivated as never,
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
    expect(browserSend).toHaveBeenCalledWith("Target.createTarget", { url: "https://x.test" });
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/TID-NEW");
    expect(mgr.activeTargetId()).toBe("TID-NEW");
    const created = tabs.find((t) => t.targetId === "TID-NEW")!;
    expect(created.active).toBe(true);
    expect(created.label).toBe("docs");
  });

  it("close() closes the target and re-activates a remaining tab when the active one closed", async () => {
    // active is "A" (initialTargetId). Close it; fall back to "B".
    listMock
      .mockResolvedValueOnce([tgt("A"), tgt("B")]) // initial list() to assign ids
      .mockResolvedValueOnce([tgt("A"), tgt("B")]) // close(): resolve ref
      .mockResolvedValueOnce([tgt("B")]) // close(): remaining after closeTarget
      .mockResolvedValue([tgt("B")]); // final list()
    await mgr.list();
    const tabs = await mgr.close("t1");
    expect(browserSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "A" });
    expect(cdp.reconnect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/page/B");
    expect(mgr.activeTargetId()).toBe("B");
    expect(tabs.map((t) => t.targetId)).toEqual(["B"]);
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

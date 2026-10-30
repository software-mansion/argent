import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { goBack, goForward, navigate, reload } from "../src/chromium-server/navigation";
import {
  chromiumImpl,
  type OpenUrlChromiumServices,
} from "../src/tools/open-url/platforms/chromium";
import type { CDPClient } from "../src/utils/debugger/cdp-client";

function stubCdp(history?: {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}) {
  const send = vi.fn().mockImplementation((method: string) => {
    if (method === "Page.getNavigationHistory" && history) return Promise.resolve(history);
    return Promise.resolve({});
  });
  return { send } as unknown as CDPClient;
}

describe("chromium-server/navigation", () => {
  it("navigate: forwards to Page.navigate", async () => {
    const cdp = stubCdp();
    await navigate(cdp, "https://example.com");
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledWith("Page.navigate", { url: "https://example.com" });
  });

  it("navigate: throws on the errorText of a failed navigation", async () => {
    const send = vi.fn().mockResolvedValue({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
    const err = await navigate({ send } as unknown as CDPClient, "http://x.invalid/").catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toBe("Chromium could not navigate: net::ERR_NAME_NOT_RESOLVED.");
    expect(getFailureSignal(err)).toEqual({
      error_code: FAILURE_CODES.CHROMIUM_NAVIGATE_FAILED,
      failure_stage: "chromium_navigate",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  });

  it("navigate: explains an aborted navigation without echoing the url", async () => {
    const send = vi.fn().mockResolvedValue({ errorText: "net::ERR_ABORTED", isDownload: false });
    const err = await navigate(
      { send } as unknown as CDPClient,
      "http://user:pass@h/?token=secret"
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "Chromium could not navigate: net::ERR_ABORTED. Chromium aborts a URL it does not load in" +
        " a page, such as tel:, mailto: or an unknown scheme, a response with no content, and a" +
        " navigation another one replaced."
    );
  });

  it("navigate: resolves on a download", async () => {
    const send = vi.fn().mockResolvedValue({ errorText: "net::ERR_ABORTED", isDownload: true });
    await expect(navigate({ send } as unknown as CDPClient, "http://h/f.zip")).resolves.toBe(
      undefined
    );
  });

  it("navigate: throws on a download whose response failed", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ errorText: "net::ERR_INVALID_RESPONSE", isDownload: true });
    await expect(navigate({ send } as unknown as CDPClient, "http://h/404.zip")).rejects.toThrow(
      "Chromium could not navigate: net::ERR_INVALID_RESPONSE."
    );
  });

  it("navigate: resolves on a javascript: URL, which runs instead of loading", async () => {
    const send = vi.fn().mockResolvedValue({ errorText: "net::ERR_ABORTED" });
    await expect(
      navigate({ send } as unknown as CDPClient, " JavaScript:document.title='x'")
    ).resolves.toBe(undefined);
  });

  it("navigate: a repeat of a URL still in flight waits for it instead of sending again", async () => {
    let finish!: (v: object) => void;
    const send = vi
      .fn()
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockResolvedValue({ errorText: "net::ERR_ABORTED" });
    const cdp = { send } as unknown as CDPClient;
    const first = navigate(cdp, "http://h/slow");
    const repeat = navigate(cdp, "http://H/slow");
    expect(send).toHaveBeenCalledTimes(1);
    finish({});
    await expect(Promise.all([first, repeat])).resolves.toEqual([undefined, undefined]);

    await expect(navigate(cdp, "http://h/slow")).rejects.toThrow("net::ERR_ABORTED");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("navigate: a repeat shares the failure of the navigation it waited for", async () => {
    let finish!: (v: object) => void;
    const send = vi.fn().mockReturnValueOnce(new Promise((r) => (finish = r)));
    const cdp = { send } as unknown as CDPClient;
    const first = navigate(cdp, "http://h/slow").catch((e: unknown) => e);
    const repeat = navigate(cdp, "http://h/slow").catch((e: unknown) => e);
    finish({ errorText: "net::ERR_ABORTED" });
    for (const err of await Promise.all([first, repeat])) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_NAVIGATE_FAILED);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("navigate: sends a different URL, or a repeated javascript: URL, while one is in flight", async () => {
    const send = vi.fn().mockReturnValue(new Promise(() => {}));
    const cdp = { send } as unknown as CDPClient;
    void navigate(cdp, "http://h/slow");
    void navigate(cdp, "http://h/other");
    void navigate(cdp, "javascript:void 0");
    void navigate(cdp, "javascript:void 0");
    expect(send.mock.calls.map((c) => c[1].url)).toEqual([
      "http://h/slow",
      "http://h/other",
      "javascript:void 0",
      "javascript:void 0",
    ]);
  });

  it("open-url: propagates a failed navigation without refreshing the viewport", async () => {
    const refreshViewport = vi.fn();
    const services = {
      chromium: { navigate: vi.fn().mockRejectedValue(new Error("rejected")), refreshViewport },
    } as unknown as OpenUrlChromiumServices;
    await expect(
      chromiumImpl.handler(services, { udid: "chromium-cdp-9222", url: "x://y" }, {} as DeviceInfo)
    ).rejects.toThrow("rejected");
    expect(refreshViewport).not.toHaveBeenCalled();
  });

  it("navigate: resolves on an HTTP error status", async () => {
    const send = vi.fn().mockResolvedValue({ errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
    await expect(navigate({ send } as unknown as CDPClient, "http://h/404")).resolves.toBe(
      undefined
    );
  });

  it("reload: forwards ignoreCache flag", async () => {
    const cdp = stubCdp();
    await reload(cdp, true);
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
  });

  it("goBack: at the oldest entry returns false without navigating", async () => {
    const cdp = stubCdp({
      currentIndex: 0,
      entries: [{ id: 1, url: "about:blank", title: "" }],
    });
    expect(await goBack(cdp)).toBe(false);
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    // Only the history-query was called — no navigateToHistoryEntry.
    const navs = send.mock.calls.filter((c) => c[0] === "Page.navigateToHistoryEntry");
    expect(navs.length).toBe(0);
  });

  it("goBack: walks one entry and navigates to its id", async () => {
    const cdp = stubCdp({
      currentIndex: 2,
      entries: [
        { id: 1, url: "/a", title: "" },
        { id: 2, url: "/b", title: "" },
        { id: 3, url: "/c", title: "" },
      ],
    });
    expect(await goBack(cdp)).toBe(true);
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledWith("Page.navigateToHistoryEntry", { entryId: 2 });
  });

  it("goForward: at the newest entry returns false", async () => {
    const cdp = stubCdp({
      currentIndex: 2,
      entries: [
        { id: 1, url: "/a", title: "" },
        { id: 2, url: "/b", title: "" },
        { id: 3, url: "/c", title: "" },
      ],
    });
    expect(await goForward(cdp)).toBe(false);
  });
});

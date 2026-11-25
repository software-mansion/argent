// Chrome 158+ publishes no accessibility tree for a regular tab while only
// UiAutomation is connected; describe reads the page over DevTools instead.
// Shapes below are from Chromium 160 on a 1080x2424 emulator (dpr 2.625).
import { describe, it, expect, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import {
  chromeContentRect,
  chromeViewsIn,
  findChromeTab,
  mapWebTree,
} from "../src/tools/describe/platforms/android/chrome-tab";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import {
  androidChromeCdpBlueprint,
  parseChromeDevtoolsSockets,
} from "../src/blueprints/android-chrome-cdp";
import type { DescribeNode } from "../src/tools/describe/contract";
import { useAutoAdvancingClock } from "./helpers/auto-clock";

// The device side of the DevTools blueprint: sockets in /proc/net/unix, the
// browser behind each forwarded port, and each tab's answer to a probe.
const device = vi.hoisted(() => ({
  procNetUnix: "",
  /** Socket name → browser package, read through the port forwarded to it. */
  owners: new Map<string, string>(),
  /** Socket name → `/json/version`'s Browser; a missing one reads as unknown. */
  browsers: new Map<string, string>(),
  ports: new Map<string, number>(),
  targets: new Map<number, { id: string; webSocketDebuggerUrl: string }[]>(),
  /** Tab URL → its visibilityState; a missing one never answers. */
  visibility: new Map<string, string>(),
  /** Tab URLs whose socket the browser closed, by quitting. */
  closed: new Set<string>(),
}));

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adbShell: vi.fn(async () => device.procNetUnix),
  adbForward: vi.fn(async (_s: string, _p: number, to: { localabstract: string }) => {
    if (!device.ports.has(to.localabstract)) {
      device.ports.set(to.localabstract, 9000 + device.ports.size);
    }
    return String(device.ports.get(to.localabstract));
  }),
  runAdb: vi.fn(async () => ""),
}));

vi.mock("../src/chromium-server/cdp-session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureCdpReachable: vi.fn(async (port: number) => {
    const name = [...device.ports].find(([, p]) => p === port)![0];
    return { "Android-Package": device.owners.get(name), "Browser": device.browsers.get(name) };
  }),
  listPageTargets: vi.fn(async (port: number) => device.targets.get(port) ?? []),
}));

vi.mock("../src/utils/debugger/cdp-client", () => ({
  CDPClient: class {
    constructor(readonly url: string) {}
    connect = async () => undefined;
    disconnect = async () => undefined;
    isConnected = () => !device.closed.has(this.url);
    send = (_method: string, params: { expression: string }, timeoutMs: number) =>
      new Promise((resolve, reject) => {
        if (params.expression !== "document.visibilityState") {
          resolve({ result: { value: JSON.stringify(VIEWPORT) } });
          return;
        }
        const state = device.visibility.get(this.url);
        if (state) resolve({ result: { value: state } });
        else setTimeout(() => reject(new Error("timed out")), timeoutMs);
      });
  },
}));

vi.mock("../src/tools/describe/platforms/chromium", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evaluateDescribeDom: vi.fn(async () => ({
    tree: { role: "html", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
    source: "cdp-dom",
  })),
}));

useAutoAdvancingClock();

const SCREEN = { width: 1080, height: 2424 };
// innerHeight 739 CSS px × 2.625 = 1940 px: from under the toolbar (290 px) down
// to the bottom bar (2213 px), give or take Chrome's rounding.
const VIEWPORT = {
  innerWidth: 411,
  innerHeight: 731,
  dpr: 2.625,
  offsetLeft: 0,
  offsetTop: 0,
  width: 411,
  height: 731,
  scale: 1,
};

const node = (
  role: string,
  frame: [number, number, number, number],
  extra: Partial<DescribeNode> = {},
  children: DescribeNode[] = []
): DescribeNode => ({
  role,
  frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
  children,
  ...extra,
});

/** A Chromium 160 tab in a non-English UI: the content view's label is localized. */
const COLD_TAB = `<?xml version='1.0'?><hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="org.chromium.chrome" content-desc="Widok sieci" bounds="[0,142][1080,2424]"/>
  <node class="android.widget.FrameLayout" package="org.chromium.chrome" resource-id="org.chromium.chrome:id/toolbar" content-desc="apple.com" long-clickable="true" bounds="[0,142][1080,290]">
    <node class="android.widget.EditText" package="org.chromium.chrome" resource-id="org.chromium.chrome:id/url_bar" text="apple.com" clickable="true" bounds="[400,142][700,290]"/>
  </node>
</hierarchy>`;

describe("findChromeTab", () => {
  it("finds the content view beside a Chrome-family toolbar whatever its label", () => {
    const content = node("FrameLayout", [0, 0.059, 1, 0.941], { label: "Widok sieci" });
    const tree = node("Screen", [0, 0, 1, 1], {}, [
      content,
      node("FrameLayout", [0, 0.059, 1, 0.061], { identifier: "org.chromium.chrome:id/toolbar" }),
    ]);
    const tab = findChromeTab(tree);
    expect(tab?.content).toBe(content);
    expect(tab?.pkg).toBe("org.chromium.chrome");
    expect(tab?.toolbarBottom).toBeCloseTo(0.12);
  });

  it("ignores an empty view beside another app's toolbar", () => {
    const tree = node("Screen", [0, 0, 1, 1], {}, [
      node("FrameLayout", [0, 0.1, 1, 0.9], { label: "Web View" }),
      node("FrameLayout", [0, 0, 1, 0.1], { identifier: "com.example:id/toolbar" }),
    ]);
    expect(findChromeTab(tree)).toBeUndefined();
  });

  const read = (xml: string) => {
    const tree = parseUiAutomatorDump(xml, SCREEN.width, SCREEN.height);
    return findChromeTab(tree, chromeViewsIn(xml, SCREEN));
  };

  it("finds a scrolled tab, whose toolbar is hidden, only when the dump holds the browser's window", () => {
    const tree = node("Screen", [0, 0, 1, 1], {}, [
      node("FrameLayout", [0, 0.059, 1, 0.941], { label: "Web View" }),
    ]);
    expect(findChromeTab(tree)).toBeUndefined();
    const scrolled = `<?xml version='1.0'?><hierarchy rotation="0">
      <node class="android.widget.FrameLayout" package="com.android.chrome" content-desc="Web View" bounds="[0,142][1080,2424]"/>
    </hierarchy>`;
    expect(read(scrolled)?.pkg).toBe("com.android.chrome");
  });

  it("does not take another app's big view for a scrolled tab beside Chrome in picture-in-picture", () => {
    const pip = `<?xml version='1.0'?><hierarchy rotation="0">
      <node class="android.widget.FrameLayout" package="com.example.reader" content-desc="Article" bounds="[0,0][1080,2424]"/>
      <node class="android.widget.FrameLayout" package="com.android.chrome" content-desc="Web View" bounds="[600,1800][1040,2100]"/>
    </hierarchy>`;
    expect(read(pip)).toBeUndefined();
  });
});

describe("chromeContentRect + mapWebTree", () => {
  const tab = {
    content: node("FrameLayout", [0, 142 / 2424, 1, 1 - 142 / 2424]),
    pkg: "org.chromium.chrome",
    toolbarBottom: 290 / 2424,
  };

  it("puts the viewport under the toolbar and maps CSS px to screen fractions", () => {
    const clip = chromeContentRect(tab, VIEWPORT, SCREEN)!;
    expect(clip.top).toBeCloseTo(290);
    // A 200x60 CSS px button 16 px in, 100 px down the page.
    const button = node("button", [16 / 411, 100 / 731, 200 / 411, 60 / 731], {
      label: "Buy",
    });
    const [mapped] = mapWebTree(button, VIEWPORT, clip, SCREEN);
    expect(mapped!.frame.x).toBeCloseTo((16 * 2.625) / 1080);
    expect(mapped!.frame.y).toBeCloseTo((290 + 100 * 2.625) / 2424);
    expect(mapped!.frame.width).toBeCloseTo((200 * 2.625) / 1080);
    expect(mapped!.frame.height).toBeCloseTo((60 * 2.625) / 2424);
  });

  it("follows a pinch zoom: visual viewport offset and scale", () => {
    const zoomed = {
      ...VIEWPORT,
      scale: 2,
      width: 205.5,
      height: 365.5,
      offsetLeft: 100,
      offsetTop: 50,
    };
    const clip = chromeContentRect(tab, zoomed, SCREEN)!;
    const el = node("a", [110 / 411, 60 / 731, 20 / 411, 10 / 731]);
    const [mapped] = mapWebTree(el, zoomed, clip, SCREEN);
    expect(mapped!.frame.x).toBeCloseTo((10 * 2 * 2.625) / 1080);
    expect(mapped!.frame.y).toBeCloseTo((290 + 10 * 2 * 2.625) / 2424);
  });

  it("drops what falls outside the viewport and lifts its visible children", () => {
    const clip = chromeContentRect(tab, VIEWPORT, SCREEN)!;
    const below = node("p", [0, 2, 1, 0.1], { label: "below the fold" });
    // A zero-height wrapper whose child still paints on screen.
    const wrapper = node("div", [0, 0.5, 1, 0], {}, [
      node("span", [0, 0.5, 0.5, 0.05], { label: "kept" }),
    ]);
    const out = mapWebTree(
      node("body", [0, 0, 1, 3], {}, [below, wrapper]),
      VIEWPORT,
      clip,
      SCREEN
    );
    expect(out[0]!.children.map((c) => c.label)).toEqual(["kept"]);
    // The body is clipped to the viewport's bottom.
    expect(out[0]!.frame.y + out[0]!.frame.height).toBeCloseTo((290 + 731 * 2.625) / 2424);
  });

  it("falls back to the content view's top once the toolbar has scrolled away", () => {
    const tall = { ...VIEWPORT, height: 2282 / 2.625 };
    expect(chromeContentRect(tab, tall, SCREEN)!.top).toBeCloseTo(142);
    // A viewport taller than the content view matches neither top.
    expect(chromeContentRect(tab, { ...VIEWPORT, height: 1200 }, SCREEN)).toBeUndefined();
  });
});

describe("parseChromeDevtoolsSockets", () => {
  it("keeps Chrome's sockets and skips WebView and Stetho ones", () => {
    const proc = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 54695 @chrome_devtools_remote",
      "0000000000000000: 00000002 00000000 00010000 0001 01 54696 @chrome_devtools_remote_4242",
      "0000000000000000: 00000002 00000000 00010000 0001 01 18621 @stetho_com.example_devtools_remote",
      "0000000000000000: 00000002 00000000 00010000 0001 01 18622 @webview_devtools_remote_777",
      "0000000000000000: 00000003 00000000 00000000 0001 03 54697 @chrome_devtools_remote",
    ].join("\n");
    expect([...parseChromeDevtoolsSockets(proc)]).toEqual([
      ["chrome_devtools_remote", "54695"],
      ["chrome_devtools_remote_4242", "54696"],
    ]);
  });
});

describe("androidChromeCdpBlueprint", () => {
  const socketLine = (inode: number, name: string) =>
    `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} @${name}`;
  const tab = (id: string) => ({ id, webSocketDebuggerUrl: `ws://${id}` });

  async function readerFor(serial: string) {
    const { api } = await androidChromeCdpBlueprint.factory({} as never, serial);
    return api;
  }

  it("reads the package again when another browser takes over a socket name", async () => {
    device.ports.clear();
    device.owners = new Map([
      ["chrome_devtools_remote", "org.chromium.chrome"],
      ["chrome_devtools_remote_77", "com.android.chrome"],
    ]);
    device.procNetUnix = [
      socketLine(11, "chrome_devtools_remote"),
      socketLine(12, "chrome_devtools_remote_77"),
    ].join("\n");
    device.targets = new Map([
      [9000, [tab("chromium-1")]],
      [9001, [tab("chrome-1")]],
    ]);
    device.visibility = new Map([
      ["ws://chromium-1", "visible"],
      ["ws://chrome-1", "visible"],
      ["ws://chromium-2", "visible"],
    ]);
    const api = await readerFor("emulator-5554");
    await api.readVisibleTab("org.chromium.chrome");

    // Both restart the other way round: Chrome takes the plain name.
    device.closed = new Set(["ws://chromium-1", "ws://chrome-1"]);
    device.owners = new Map([
      ["chrome_devtools_remote", "com.android.chrome"],
      ["chrome_devtools_remote_88", "org.chromium.chrome"],
    ]);
    device.procNetUnix = [
      socketLine(21, "chrome_devtools_remote"),
      socketLine(22, "chrome_devtools_remote_88"),
    ].join("\n");
    device.targets = new Map([
      [9000, [tab("chrome-2")]],
      [9002, [tab("chromium-2")]],
    ]);
    const { listPageTargets } = await import("../src/chromium-server/cdp-session");
    vi.mocked(listPageTargets).mockClear();
    await api.readVisibleTab("org.chromium.chrome");
    expect(vi.mocked(listPageTargets).mock.calls.map((c) => c[0])).toEqual([9002]);
  });

  it.each([
    { browser: "Chrome/145.0.7632.0", read: false },
    { browser: "Chrome/158.0.7700.0", read: true },
    // A version it cannot parse is taken for a new one.
    { browser: "Chrome/unknown", read: true },
  ])("reads a $browser tab over DevTools: $read", async ({ browser, read }) => {
    device.ports.clear();
    device.owners = new Map([["chrome_devtools_remote", "com.android.chrome"]]);
    device.browsers = new Map([["chrome_devtools_remote", browser]]);
    device.procNetUnix = socketLine(51, "chrome_devtools_remote");
    device.targets = new Map([[9000, [tab("t")]]]);
    device.visibility = new Map([["ws://t", "visible"]]);
    const { listPageTargets } = await import("../src/chromium-server/cdp-session");
    vi.mocked(listPageTargets).mockClear();
    const api = await readerFor(`emulator-${browser}`);
    const reading = api.readVisibleTab("com.android.chrome");
    if (read) {
      await expect(reading).resolves.toBeDefined();
    } else {
      // Older Chrome publishes the tab to accessibility: describe waits for that.
      await expect(reading).rejects.toThrow(/Chrome 145/);
      expect(listPageTargets).not.toHaveBeenCalled();
    }
    device.browsers = new Map();
  });

  it("settles on the visible tab at once while restored tabs never answer", async () => {
    device.ports.clear();
    device.owners = new Map([["chrome_devtools_remote", "org.chromium.chrome"]]);
    device.procNetUnix = socketLine(31, "chrome_devtools_remote");
    // The visible tab is last, after two restored ones.
    device.targets = new Map([[9000, [tab("old-1"), tab("old-2"), tab("shown")]]]);
    device.visibility = new Map([["ws://shown", "visible"]]);
    const api = await readerFor("emulator-5556");
    const start = Date.now();
    await api.readVisibleTab("org.chromium.chrome");
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("reuses the visible cached tab without reading the sockets or other tabs", async () => {
    device.ports.clear();
    device.owners = new Map([["chrome_devtools_remote", "org.chromium.chrome"]]);
    device.procNetUnix = socketLine(41, "chrome_devtools_remote");
    device.targets = new Map([[9000, [tab("a"), tab("b")]]]);
    device.visibility = new Map([
      ["ws://a", "visible"],
      ["ws://b", "hidden"],
    ]);
    const api = await readerFor("emulator-5558");
    await api.readVisibleTab("org.chromium.chrome");

    const { adbShell } = await import("../src/utils/adb");
    const { listPageTargets } = await import("../src/chromium-server/cdp-session");
    vi.mocked(adbShell).mockClear();
    vi.mocked(listPageTargets).mockClear();
    await api.readVisibleTab("org.chromium.chrome");
    expect(adbShell).not.toHaveBeenCalled();
    expect(listPageTargets).not.toHaveBeenCalled();

    // Another tab comes to the front: the cached one is hidden, so all are asked.
    device.visibility = new Map([
      ["ws://a", "hidden"],
      ["ws://b", "visible"],
    ]);
    await api.readVisibleTab("org.chromium.chrome");
    expect(listPageTargets).toHaveBeenCalledTimes(1);
    vi.mocked(listPageTargets).mockClear();
    // And the new front tab is the cached one from then on.
    await api.readVisibleTab("org.chromium.chrome");
    expect(listPageTargets).not.toHaveBeenCalled();
  });
});

describe("describeAndroid — Chrome tab over DevTools", () => {
  function fakeRegistry(readVisibleTab: (pkg: string) => Promise<unknown>, firstXml = COLD_TAB) {
    let reads = 0;
    const getHierarchy = vi.fn(async () => ({ xml: reads++ === 0 ? firstXml : COLD_TAB }));
    const resolveService = vi.fn(async (urn: string) =>
      urn.startsWith("AndroidChromeCdp:")
        ? { readVisibleTab }
        : {
            isReady: () => true,
            getHierarchy,
            getScreenSize: async () => ({ ...SCREEN, rotation: 0 }),
          }
    );
    return { registry: { resolveService } as unknown as Registry, getHierarchy };
  }

  it("fills the never-published content view with the page DOM", async () => {
    const readVisibleTab = vi.fn(async () => ({
      tree: node("html", [0, 0, 1, 1], {}, [
        node("button", [16 / 411, 100 / 731, 200 / 411, 60 / 731], {
          label: "Buy",
          clickable: true,
        }),
      ]),
      source: "cdp-dom",
      viewport: VIEWPORT,
    }));
    const { registry } = fakeRegistry(readVisibleTab);
    const data = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(readVisibleTab).toHaveBeenCalledWith("org.chromium.chrome");
    expect(data.source).toBe("android-devtools+cdp");
    expect(data.hint).toMatch(/DevTools/);
    const content = data.tree.children.find((c) => c.label === "Widok sieci")!;
    expect(content.role).toBe("WebView");
    expect(content.children[0]!.children[0]!.label).toBe("Buy");
  });

  it("returns as soon as the DevTools read lands, mid-step", async () => {
    const readVisibleTab = vi.fn(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({
                tree: node("html", [0, 0, 1, 1]),
                source: "cdp-dom",
                viewport: VIEWPORT,
              }),
            100
          )
        )
    );
    const { registry, getHierarchy } = fakeRegistry(readVisibleTab);
    const start = Date.now();
    const data = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(data.source).toBe("android-devtools+cdp");
    expect(Date.now() - start).toBe(100);
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it("starts the DevTools read from the first re-read that shows the tab", async () => {
    // Mid-transition: the content view is there, not yet laid out, nor the toolbar.
    const settling = `<?xml version='1.0'?><hierarchy rotation="0">
      <node class="android.widget.FrameLayout" package="org.chromium.chrome" content-desc="Web View" bounds="[0,142][1080,600]"/>
    </hierarchy>`;
    const readVisibleTab = vi.fn(async () => ({
      tree: node("html", [0, 0, 1, 1]),
      source: "cdp-dom",
      viewport: VIEWPORT,
    }));
    const { registry } = fakeRegistry(readVisibleTab, settling);
    const data = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(readVisibleTab).toHaveBeenCalledWith("org.chromium.chrome");
    expect(data.source).toBe("android-devtools+cdp");
  });

  it("keeps today's tree when the DevTools read fails", async () => {
    const { registry, getHierarchy } = fakeRegistry(async () => {
      throw new Error("no DevTools socket");
    });
    const data = await describeAndroid(registry, "emulator-5554", undefined, false);
    expect(data.source).toBe("android-devtools");
    expect(data.hint).toBeUndefined();
    // The failure does not cut the re-reads short: 1.5 s in 250 ms steps.
    expect(getHierarchy).toHaveBeenCalledTimes(7);
  });
});

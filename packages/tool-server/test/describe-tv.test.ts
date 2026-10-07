import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// The Android empty-focus fallback is describeAndroid's full UI tree; stub it so
// the TV-describe routing can be tested without adb.
const describeAndroidMock = vi.fn();
vi.mock("../src/tools/describe/platforms/android", () => ({
  describeAndroid: (...a: unknown[]) => describeAndroidMock(...a),
}));

// The Android TV helper path reads the current input method over adb.
const adbShellMock = vi.fn(async (..._a: unknown[]) => "null\n");
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell: (...a: unknown[]) => adbShellMock(...a),
}));

import { describeTv } from "../src/tools/describe/platforms/tv";
import type { TvControlApi, TvDescribeResponse } from "../src/blueprints/tv-control";

// The tool touches `describe()` and `recycleAx()`; the rest is unused here.
function makeApi(
  describeFn: TvControlApi["describe"],
  recycleAx: TvControlApi["recycleAx"] = vi.fn().mockResolvedValue(undefined)
): TvControlApi {
  return {
    describe: describeFn,
    recycleAx,
    navigate: vi.fn(),
    type: vi.fn(),
  } as unknown as TvControlApi;
}

// describeTv resolves the TvControlApi through the registry; the unit tests
// inject it directly by stubbing resolveService.
function makeRegistry(api: TvControlApi) {
  return { resolveService: vi.fn(async () => api) } as never;
}

// Apple TV target — platform "ios" by UDID shape, so no Android fallback fires.
const TVOS_DEVICE: DeviceInfo = {
  id: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
  platform: "ios",
  kind: "simulator",
};

const populated: TvDescribeResponse = {
  bundleId: "com.nfl.gamecenter",
  focused: { label: "Home", isFocused: true },
  focusable: [{ label: "Home", isFocused: true }, { label: "Games" }],
};

const empty: TvDescribeResponse = {
  bundleId: "com.nfl.gamecenter",
  focused: null,
  focusable: [],
};

async function run(api: TvControlApi) {
  return describeTv(makeRegistry(api), TVOS_DEVICE);
}

describe("describe (TV) — empty-state resilience", () => {
  it("returns the populated focus view without retrying", async () => {
    const describeFn = vi.fn().mockResolvedValue(populated);
    const res = await run(makeApi(describeFn));

    expect(describeFn).toHaveBeenCalledTimes(1);
    expect(res.source).toBe("tv-focus");
    expect(res.description).toContain("Focused: Home");
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
    expect(res.description).not.toContain("Note:");
  });

  it("retries while empty and returns the tree once it populates (app finished loading)", async () => {
    // First two probes hit the splash/loading window, third sees the real UI.
    const describeFn = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const res = await run(makeApi(describeFn));

    expect(describeFn).toHaveBeenCalledTimes(3);
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
  });

  it("recycles the daemon and recovers when the cache was stale", async () => {
    // The transition-window retries stay empty (stale primaryApp cache), then a
    // recycle rebinds to the real foreground app and the next probe populates.
    const describeFn = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describeFn, recycleAx));

    expect(describeFn).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
  });

  it("exhausts retries, recycles, and surfaces the hint when still empty", async () => {
    const describeFn = vi.fn().mockResolvedValue(empty);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describeFn, recycleAx));

    // 3 transition-window probes + 1 post-recycle probe.
    expect(describeFn).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.description).toContain("Focusable: (none reported)");
    expect(res.hint).toMatch(/still launching|loading|transition|recycl/i);
    expect(res.description).toContain("Note:");
  });
});

// Android TV target — platform "android" by serial shape.
const ANDROID_TV_DEVICE: DeviceInfo = {
  id: "emulator-5556",
  platform: "android",
  kind: "emulator",
};

describe("describe (Android TV) — reads through the android-devtools helper", () => {
  // A running helper holds the device's only UiAutomation connection, so a
  // `uiautomator dump` (api.describe) beside it dies `Killed`.
  const HELPER_XML =
    `<?xml version='1.0'?><hierarchy rotation="0">` +
    `<node class="android.widget.Button" content-desc="Play" text="" focusable="true" focused="true" enabled="true" package="com.example.tv" />` +
    `<node class="android.widget.TextView" content-desc="Settings" text="" focusable="true" focused="false" enabled="true" package="com.example.tv" />` +
    `</hierarchy>`;

  function routedRegistry(api: TvControlApi, helper: () => Promise<unknown>) {
    return {
      resolveService: vi.fn(async (urn: string) =>
        urn.startsWith("AndroidDevtools:") ? helper() : api
      ),
    } as never;
  }

  it("goes straight to the full-tree fallback on an empty helper focus view", async () => {
    // On Android TV an empty focus set is steady state (react-native-tvos's own
    // focus engine), not a transition: no retry loop, no recycle, no dump.
    const describeFn = vi.fn().mockResolvedValue(populated);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const getHierarchy = vi.fn(async () => ({
      xml: `<?xml version='1.0'?><hierarchy rotation="0"><node class="android.view.View" text="" content-desc="" focusable="false" focused="false" package="com.example.tv" /></hierarchy>`,
    }));
    const frame = { x: 0, y: 0, width: 100, height: 50 };
    describeAndroidMock.mockReset();
    describeAndroidMock.mockResolvedValue({
      tree: {
        role: "RCTView",
        frame,
        children: [{ role: "AXButton", label: "Play", frame, children: [] }],
      },
      source: "android-devtools",
    });

    const res = await describeTv(
      routedRegistry(makeApi(describeFn, recycleAx), async () => ({ getHierarchy })),
      ANDROID_TV_DEVICE
    );

    expect(getHierarchy).toHaveBeenCalledTimes(1);
    expect(describeFn).not.toHaveBeenCalled();
    expect(recycleAx).not.toHaveBeenCalled();
    expect(describeAndroidMock).toHaveBeenCalledTimes(1);
    // The helper is up, so the fallback must read through it: a dump would die.
    expect(describeAndroidMock.mock.calls[0]![0]).toBeDefined();
    expect(res.hint).toMatch(/Android TV focus engine/i);
  });

  it("takes the focus view from the helper without a uiautomator dump", async () => {
    const describeFn = vi.fn().mockResolvedValue(empty);
    const registry = routedRegistry(makeApi(describeFn), async () => ({
      getHierarchy: async () => ({ xml: HELPER_XML }),
    }));

    const res = await describeTv(registry, ANDROID_TV_DEVICE);

    expect(describeFn).not.toHaveBeenCalled();
    expect(res.description).toContain("App: com.example.tv");
    expect(res.description).toContain("Focused: Play [button]");
    expect(res.description).toContain("Focusable (2):");
  });

  it("does not start the helper a second time for the empty-focus fallback", async () => {
    const describeFn = vi.fn().mockResolvedValue(empty);
    const helper = vi.fn(async () => {
      throw new Error("helper APK not installable");
    });
    const frame = { x: 0, y: 0, width: 100, height: 50 };
    describeAndroidMock.mockReset();
    describeAndroidMock.mockResolvedValue({
      tree: { role: "RCTView", frame, children: [] },
      source: "uiautomator",
    });

    await describeTv(routedRegistry(makeApi(describeFn), helper), ANDROID_TV_DEVICE);

    expect(helper).toHaveBeenCalledTimes(1);
    expect(describeAndroidMock).toHaveBeenCalledTimes(1);
    expect(describeAndroidMock.mock.calls[0]![0]).toBeUndefined();
  });

  it("falls back to the uiautomator dump when the helper cannot start", async () => {
    const describeFn = vi.fn().mockResolvedValue(populated);
    const registry = routedRegistry(makeApi(describeFn), async () => {
      throw new Error("helper APK not installable");
    });

    const res = await describeTv(registry, ANDROID_TV_DEVICE);

    expect(describeFn).toHaveBeenCalledTimes(1);
    expect(res.description).toContain("Focused: Home");
  });
});

// Trimmed from real android-devtools helper captures on an Android TV API 34
// emulator; node attributes are verbatim.
describe("describe (Android TV) — helper hierarchy captured on a device", () => {
  const IME = "com.google.android.inputmethod.latin";
  // TV Settings > Network & Internet > Proxy settings > Manual, keyboard up:
  // the helper emits the IME window first, then the app window, and each keeps
  // its own focused view.
  const IME_UP_XML =
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1920,1080]">` +
    `<node index="0" text="" resource-id="com.google.android.inputmethod.latin:id/key_pos_voice" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="Voice input" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[928,616][992,680]" />` +
    `<node index="0" text="" resource-id="com.google.android.inputmethod.latin:id/key_pos_0_0" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="q" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[564,712][646,798]" />` +
    `<node index="1" text="" resource-id="com.google.android.inputmethod.latin:id/key_pos_0_1" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="w" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[643,712][722,798]" />` +
    `</node>` +
    `<node index="1" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.tv.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1920,1080]">` +
    `<node index="0" text="proxy.example.com" resource-id="com.android.tv.settings:id/guidedactions_item_title" class="android.widget.EditText" package="com.android.tv.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1199,291][1671,387]" />` +
    `</node>` +
    `</hierarchy>`;

  // Launcher on a 1080x1920 display: Details / Dismiss sit past the right edge,
  // and the helper reports them with inverted bounds.
  const OFFSCREEN_XML =
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.tvlauncher" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">` +
    `<node index="2" text="Details" resource-id="com.google.android.tvlauncher:id/tray_see_more" class="android.widget.Button" package="com.google.android.tvlauncher" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1442,257][1080,313]" />` +
    `<node index="3" text="Dismiss" resource-id="com.google.android.tvlauncher:id/tray_dismiss" class="android.widget.Button" package="com.google.android.tvlauncher" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1606,257][1080,313]" />` +
    `<node index="0" text="" resource-id="com.google.android.tvlauncher:id/favorite_add_app_banner" class="android.widget.LinearLayout" package="com.google.android.tvlauncher" content-desc="Add app to favorites" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[109,447][357,608]" />` +
    `<node index="0" text="Home" resource-id="" class="android.widget.TextView" package="com.google.android.tvlauncher" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[296,46][438,87]" />` +
    `<node index="1" text="Shop" resource-id="" class="android.widget.TextView" package="com.google.android.tvlauncher" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[430,1940][572,1920]" />` +
    `</node>` +
    `</hierarchy>`;

  function helperRegistry(xml: string) {
    return {
      resolveService: vi.fn(async (urn: string) =>
        urn.startsWith("AndroidDevtools:")
          ? { getHierarchy: async () => ({ xml }) }
          : makeApi(vi.fn().mockResolvedValue(empty))
      ),
    } as never;
  }

  it("with the keyboard up, names the app, focuses the key under the cursor and marks only it", async () => {
    adbShellMock.mockResolvedValueOnce(`${IME}/com.android.inputmethod.latin.LatinIME\n`);

    const res = await describeTv(helperRegistry(IME_UP_XML), ANDROID_TV_DEVICE);

    expect(adbShellMock).toHaveBeenCalledWith(
      ANDROID_TV_DEVICE.id,
      "settings get secure default_input_method",
      expect.anything()
    );
    expect(res.description).toBe(
      [
        "App: com.android.tv.settings",
        "Focused: q",
        "Focusable (4):",
        "  Voice input",
        "→ q",
        "  w",
        "  proxy.example.com [textfield]",
      ].join("\n")
    );
  });

  it("keeps the helper's focus view when the keyboard-package read fails", async () => {
    adbShellMock.mockRejectedValueOnce(new Error("adb: device offline"));
    const describeFn = vi.fn().mockResolvedValue(populated);
    const registry = {
      resolveService: vi.fn(async (urn: string) =>
        urn.startsWith("AndroidDevtools:")
          ? { getHierarchy: async () => ({ xml: OFFSCREEN_XML }) }
          : makeApi(describeFn)
      ),
    } as never;

    const res = await describeTv(registry, ANDROID_TV_DEVICE);

    expect(describeFn).not.toHaveBeenCalled();
    expect(res.description).toContain("Focused: Add app to favorites");
  });

  it("leaves out focusable views the helper reports outside the display", async () => {
    const res = await describeTv(helperRegistry(OFFSCREEN_XML), ANDROID_TV_DEVICE);

    expect(res.description).toBe(
      [
        "App: com.google.android.tvlauncher",
        "Focused: Add app to favorites",
        "Focusable (2):",
        "→ Add app to favorites",
        "  Home",
      ].join("\n")
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";

// The Android TV backend drives the device entirely through `adb` helpers.
// Mock them so the factory + api run without a real device.
vi.mock("../src/utils/adb", () => ({
  adbShell: vi.fn(async () => ""),
  adbExecOutBinary: vi.fn(async () => Buffer.from("")),
  shellQuote: (v: string) => `'${v.replace(/'/g, "'\\''")}'`,
  getAndroidRuntimeKind: vi.fn(async () => "tv" as const),
}));

import {
  androidTvControlBlueprint,
  androidTvControlRef,
} from "../src/blueprints/android-tv-control";
import type { TvControlApi } from "../src/blueprints/tv-control-types";
import { adbShell, adbExecOutBinary, getAndroidRuntimeKind } from "../src/utils/adb";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";

const mockShell = vi.mocked(adbShell);
const mockExecOut = vi.mocked(adbExecOutBinary);
const mockRuntimeKind = vi.mocked(getAndroidRuntimeKind);

const SERIAL = "emulator-5556";
const device = { id: SERIAL, platform: "android" as const, kind: "emulator" as const };

async function makeApi(): Promise<TvControlApi> {
  const instance = await androidTvControlBlueprint.factory({}, device, { device });
  return instance.api;
}

// Build a uiautomator dump with the given focusable nodes. `focusedIndex` marks
// which one carries focused="true".
function dump(
  nodes: Array<{ label: string; bounds: string; cls?: string; text?: string }>,
  focusedIndex: number
): Buffer {
  const inner = nodes
    .map((n, i) => {
      const cls = n.cls ?? "android.widget.TextView";
      const focused = i === focusedIndex ? "true" : "false";
      const text = n.text ?? "";
      return `<node class="${cls}" content-desc="${n.label}" text="${text}" bounds="${n.bounds}" focusable="true" focused="${focused}" enabled="true" package="com.example.tv" />`;
    })
    .join("");
  return Buffer.from(`<?xml version='1.0'?><hierarchy rotation="0">${inner}</hierarchy>`);
}

beforeEach(() => {
  mockShell.mockReset();
  mockShell.mockResolvedValue("");
  mockExecOut.mockReset();
  mockRuntimeKind.mockReset();
  mockRuntimeKind.mockResolvedValue("tv");
});

describe("android-tv-control — ref + factory gating", () => {
  it("builds a namespaced ref", () => {
    const ref = androidTvControlRef(device);
    expect(ref.urn).toBe(`AndroidTvControl:${SERIAL}`);
    expect(ref.options.device).toBe(device);
  });

  it("rejects a non-TV (mobile) device with an UnsupportedOperationError (→ 400, not 500)", async () => {
    mockRuntimeKind.mockResolvedValue("mobile");
    const err = await makeApi().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(UnsupportedOperationError);
    expect(err.message).toMatch(/Android-TV-only/);
  });

  it("rejects an offline / unknown serial", async () => {
    mockRuntimeKind.mockResolvedValue(undefined);
    await expect(makeApi()).rejects.toThrow(/no ready Android device/);
  });
});

describe("android-tv-control — navigate maps to keyevents", () => {
  it.each([
    ["up", 19],
    ["down", 20],
    ["left", 21],
    ["right", 22],
    ["select", 23],
    ["back", 4],
    ["home", 3],
    ["menu", 82],
    ["playPause", 85],
    ["rewind", 89],
    ["fastForward", 90],
    ["next", 87],
    ["previous", 88],
    ["volumeUp", 24],
    ["volumeDown", 25],
    ["mute", 164],
  ] as const)("sends %s as keyevent %i", async (direction, code) => {
    const api = await makeApi();
    await api.navigate(direction);
    expect(mockShell).toHaveBeenCalledWith(SERIAL, `input keyevent ${code}`, expect.anything());
  });
});

describe("android-tv-control — type", () => {
  it("sends spaces as KEYCODE_SPACE keyevents, not %s", async () => {
    const api = await makeApi();
    await api.type("hello world");
    const calls = mockShell.mock.calls.filter((c: unknown[]) => c[0] === SERIAL).map((c) => c[1]);
    expect(calls).toEqual(["input text 'hello'", "input keyevent 62", "input text 'world'"]);
    // The fragile "%s" space encoding is gone.
    expect(calls.some((c: string) => c.includes("%s"))).toBe(false);
  });

  it("preserves a literal %s in user text (round-trip safe)", async () => {
    const api = await makeApi();
    await api.type("50%save");
    const calls = mockShell.mock.calls.filter((c: unknown[]) => c[0] === SERIAL).map((c) => c[1]);
    // Split after the '%' so the device never collapses an adjacent "%s" into a
    // space: "%" and "save" arrive in separate `input text` calls, verbatim.
    expect(calls).toEqual(["input text '50%'", "input text 'save'"]);
    // No keyevent — there is no real space in the input.
    expect(calls.some((c: string) => c.includes("keyevent"))).toBe(false);
  });

  it("is a no-op for empty text", async () => {
    const api = await makeApi();
    await api.type("");
    // Only the factory's runtime-kind probe ran via getAndroidRuntimeKind; no
    // `input text` shell-out.
    expect(mockShell).not.toHaveBeenCalledWith(
      SERIAL,
      expect.stringContaining("input text"),
      expect.anything()
    );
  });

  // Android TV shares the `adb shell input text` sink with the phone path, and
  // with it the sink's limitations: an emoji NPEs `sendText` on-device, other
  // non-ASCII is silently dropped, and a newline truncates the input line. The
  // shared guard must reject those up front (InvalidToolInputError → 400 +
  // KEYBOARD_CHARACTER_UNSUPPORTED, same as every other keyboard backend)
  // instead of letting them surface as a raw adb 500 (hubgan review).
  it("rejects an emoji before any adb call (400-class + KEYBOARD_CHARACTER_UNSUPPORTED)", async () => {
    const api = await makeApi();
    const err = await api.type("ab😀").then(
      () => {
        throw new Error("expected type() to reject");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED);
    expect(mockShell).not.toHaveBeenCalled();
  });

  it("rejects a newline before any adb call (400-class + KEYBOARD_CHARACTER_UNSUPPORTED)", async () => {
    const api = await makeApi();
    const err = await api.type("a\nb").then(
      () => {
        throw new Error("expected type() to reject");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED);
    expect(mockShell).not.toHaveBeenCalled();
  });
});

describe("android-tv-control — describe", () => {
  it("projects the focused + focusable nodes from the uiautomator dump", async () => {
    mockExecOut.mockResolvedValue(
      dump(
        [
          { label: "Home", bounds: "[0,0][100,50]" },
          { label: "Search", bounds: "[100,0][200,50]", cls: "android.widget.Button" },
        ],
        0
      )
    );
    const api = await makeApi();
    const res = await api.describe();
    expect(res.bundleId).toBe("com.example.tv");
    expect(res.focused?.label).toBe("Home");
    expect(res.focusable).toHaveLength(2);
    expect(res.focusable[1]?.label).toBe("Search");
    expect(res.focusable[1]?.traits).toContain("button");
  });
});

// A registry that hands out a stub android-devtools helper: the only service
// the TV blueprint resolves through it.
function helperRegistry(read: () => Promise<{ xml: string }>) {
  const getHierarchy = vi.fn(read);
  const resolveService = vi.fn(async () => ({ getHierarchy }));
  return { registry: { resolveService } as unknown as Registry, resolveService, getHierarchy };
}

async function makeApiWithHelper(registry: Registry): Promise<TvControlApi> {
  const ref = androidTvControlRef(device, registry);
  const instance = await androidTvControlBlueprint.factory({}, device, ref.options);
  return instance.api;
}

function helperXml(windows: Array<{ type: number; nodes: string }>): string {
  const roots = windows
    .map(
      (w) => `<node class="android.widget.FrameLayout" window-type="${w.type}">${w.nodes}</node>`
    )
    .join("");
  return `<?xml version='1.0'?><hierarchy rotation="0">${roots}</hierarchy>`;
}

function tvNode(label: string, focused: boolean, pkg = "com.example.tv"): string {
  return `<node class="android.widget.Button" content-desc="${label}" text="" focusable="true" focused="${focused}" enabled="true" package="${pkg}" />`;
}

describe("android-tv-control — describe through the devtools helper (#1316)", () => {
  it("reads the hierarchy from the helper, with a fresh cache, and never runs uiautomator", async () => {
    const { registry, resolveService, getHierarchy } = helperRegistry(async () => ({
      xml: helperXml([{ type: 1, nodes: tvNode("Home", true) + tvNode("Search", false) }]),
    }));
    const api = await makeApiWithHelper(registry);
    const res = await api.describe();
    expect(res.focused?.label).toBe("Home");
    expect(res.focusable.map((e) => e.label)).toEqual(["Home", "Search"]);
    expect(resolveService).toHaveBeenCalledWith(`AndroidDevtools:${SERIAL}`, { device });
    expect(getHierarchy).toHaveBeenCalledWith({ clearCache: true });
    // A dump would be killed while the helper holds UiAutomation.
    expect(mockExecOut).not.toHaveBeenCalled();
  });

  it("resolves the helper per read, so a helper that exited is respawned", async () => {
    const { registry, resolveService } = helperRegistry(async () => ({
      xml: helperXml([{ type: 1, nodes: tvNode("Home", true) }]),
    }));
    const api = await makeApiWithHelper(registry);
    await api.describe();
    await api.describe();
    expect(resolveService).toHaveBeenCalledTimes(2);
  });

  it("falls back to uiautomator dump when the helper fails", async () => {
    const { registry } = helperRegistry(async () => {
      throw new Error("adb install rejected");
    });
    mockExecOut.mockResolvedValue(dump([{ label: "Home", bounds: "[0,0][100,50]" }], 0));
    const api = await makeApiWithHelper(registry);
    const res = await api.describe();
    expect(res.focused?.label).toBe("Home");
    expect(mockExecOut).toHaveBeenCalledWith(
      SERIAL,
      expect.stringContaining("uiautomator dump"),
      expect.anything()
    );
  });

  it("returns the same focus view as the uiautomator dump of the same screen", async () => {
    const nodes = [
      { label: "Home", bounds: "[0,0][100,50]" },
      { label: "Search", bounds: "[100,0][200,50]", cls: "android.widget.Button" },
    ];
    mockExecOut.mockResolvedValue(dump(nodes, 1));
    const viaDump = await (await makeApi()).describe();

    const xml = dump(nodes, 1)
      .toString("utf-8")
      .replace(
        /<hierarchy rotation="0">(.*)<\/hierarchy>/,
        `<hierarchy rotation="0"><node class="android.widget.FrameLayout" window-type="1">$1</node></hierarchy>`
      );
    const { registry } = helperRegistry(async () => ({ xml }));
    const viaHelper = await (await makeApiWithHelper(registry)).describe();
    expect(viaHelper).toEqual(viaDump);
  });

  it("reads the on-screen keyboard while it is up: the D-pad moves between its keys", async () => {
    const { registry } = helperRegistry(async () => ({
      xml: helperXml([
        // Topmost first: the IME, its highlighted key focused; the field under
        // it keeps its view focus.
        {
          type: 2,
          nodes: tvNode("q", true, "com.google.android.inputmethod") + tvNode("w", false),
        },
        { type: 1, nodes: tvNode("Search movies", true) },
      ]),
    }));
    const res = await (await makeApiWithHelper(registry)).describe();
    expect(res.focused?.label).toBe("q");
    expect(res.focusable.map((e) => e.label)).toEqual(["q", "w"]);
  });

  it("reads the app window when no window holds focus, not the keyboard", async () => {
    const { registry } = helperRegistry(async () => ({
      xml: helperXml([
        { type: 2, nodes: tvNode("q", false, "com.google.android.inputmethod") },
        { type: 1, nodes: tvNode("Search movies", false) },
      ]),
    }));
    const res = await (await makeApiWithHelper(registry)).describe();
    expect(res.focusable.map((e) => e.label)).toEqual(["Search movies"]);
  });

  it("skips a node the user can't see and its subtree, as the dump does", async () => {
    const { registry } = helperRegistry(async () => ({
      xml: helperXml([
        {
          type: 1,
          nodes:
            tvNode("Home", true) +
            `<node class="android.widget.FrameLayout" visible-to-user="false">${tvNode("Hidden tab", false)}</node>`,
        },
      ]),
    }));
    const res = await (await makeApiWithHelper(registry)).describe();
    expect(res.focusable.map((e) => e.label)).toEqual(["Home"]);
  });

  it("reads the topmost window holding focus when several are listed", async () => {
    const { registry } = helperRegistry(async () => ({
      xml: helperXml([
        { type: 3, nodes: tvNode("Volume", false, "com.android.systemui") },
        { type: 1, nodes: tvNode("OK", true) + tvNode("Cancel", false) },
        // The activity under the dialog keeps its view focus.
        { type: 1, nodes: tvNode("Play", true) },
      ]),
    }));
    const res = await (await makeApiWithHelper(registry)).describe();
    expect(res.focused?.label).toBe("OK");
    expect(res.focusable.map((e) => e.label)).toEqual(["OK", "Cancel"]);
  });
});

describe("android-tv-control — uiautomator capture errors", () => {
  it("names a held UiAutomation connection, not a lock screen, when the dump is killed", async () => {
    mockExecOut.mockResolvedValue(Buffer.from("Killed\n"));
    const err: Error = await (await makeApi()).describe().then(
      () => {
        throw new Error("expected describe() to reject");
      },
      (e: Error) => e
    );
    expect(err.message).toMatch(/Killed/);
    expect(err.message).toMatch(/UiAutomation/);
    expect(err.message).toContain("am force-stop com.argent.androiddevtools");
    expect(err.message).not.toMatch(/locked|secure overlay/);
  });

  it("keeps the lock-screen hint for other capture failures", async () => {
    mockExecOut.mockResolvedValue(
      Buffer.from("ERROR: null root node returned by UiTestAutomationBridge.")
    );
    await expect((await makeApi()).describe()).rejects.toThrow(
      /could not capture the screen: ERROR: null root node.*locked/
    );
  });
});

describe("android-tv-control — recycleAx is a no-op", () => {
  it("resolves without touching adb", async () => {
    const api = await makeApi();
    mockShell.mockClear();
    await expect(api.recycleAx()).resolves.toBeUndefined();
    expect(mockShell).not.toHaveBeenCalled();
  });
});

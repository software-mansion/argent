import { afterEach, describe, expect, it, vi } from "vitest";

const simulators = vi.hoisted(() => ({
  list: [] as { udid: string; name: string; state: string; runtimeKind: string }[],
}));
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  listIosSimulators: async () => simulators.list,
}));
import {
  buildTextTree,
  readTapAxes,
  type RawResult,
} from "../../src/tools/debugger/debugger-component-tree";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";

// A landscape window, as React Native measures an unfolded iPhone Duo's UI.
const LANDSCAPE = { screenW: 951, screenH: 669 };
const PORTRAIT = { screenW: 669, screenH: 951 };

/** One button whose centre sits at (u, v) of the window. */
function tree(screen: { screenW: number; screenH: number }, u: number, v: number): RawResult {
  const cx = u * screen.screenW;
  const cy = v * screen.screenH;
  return {
    ...screen,
    components: [
      {
        id: 0,
        name: "Pressable",
        rect: { x: cx - 10, y: cy - 10, w: 20, h: 20 },
        parentIdx: -1,
        testID: "reset",
      },
    ],
  };
}

function tapOf(text: string): string | undefined {
  return /\(tap: ([\d.]+,[\d.]+)\)/.exec(text)?.[1];
}

describe("buildTextTree — tap points on the axes the gesture tools take", () => {
  const base = { onScreenOnly: true };

  it("keeps the window's points when no orientation applies (Android, Chromium)", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), base);
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).not.toContain("The UI is");
    expect(text).not.toContain("Note:");
  });

  it("keeps the window's points for a portrait UI", () => {
    const text = buildTextTree(tree(PORTRAIT, 0.8, 0.25), { ...base, uiOrientation: "portrait" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).not.toContain("The UI is");
  });

  it("turns a landscapeLeft UI (an unfolded iPhone Duo) onto the screen's axes", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), {
      ...base,
      uiOrientation: "landscapeLeft",
    });
    // (u, v) -> (v, 1 - u)
    expect(tapOf(text)).toBe("0.25,0.20");
    expect(text).toContain("The UI is landscapeLeft on the screen.");
  });

  it("turns a landscapeRight UI (an iPhone rotated with its home side on the right)", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), {
      ...base,
      uiOrientation: "landscapeRight",
    });
    // (u, v) -> (1 - v, u)
    expect(tapOf(text)).toBe("0.75,0.80");
  });

  it("turns an upside-down UI", () => {
    const text = buildTextTree(tree(PORTRAIT, 0.8, 0.25), {
      ...base,
      uiOrientation: "portraitUpsideDown",
    });
    expect(tapOf(text)).toBe("0.20,0.75");
    expect(text).toContain("The UI is portraitUpsideDown on the screen.");
  });

  it("warns when a landscape UI's orientation could not be read, and keeps its points", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), { ...base, uiOrientation: "unknown" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).toContain("its orientation could not be read");
    expect(text).toContain("Use describe for tap points.");
  });

  it("asks for the udid when two same-named simulators leave a landscape UI unread", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), { ...base, uiOrientation: "ambiguous" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).toContain("two booted simulators have this device's name");
    expect(text).toContain("Call again with the simulator's udid");
  });

  it("does not warn about a portrait UI that two same-named simulators could run", () => {
    const text = buildTextTree(tree(PORTRAIT, 0.8, 0.25), { ...base, uiOrientation: "ambiguous" });
    expect(text).not.toContain("Note:");
  });

  it("does not warn about a portrait UI whose orientation could not be read", () => {
    const text = buildTextTree(tree(PORTRAIT, 0.8, 0.25), { ...base, uiOrientation: "unknown" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).not.toContain("Note:");
  });
});

const SIM_UDID = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const LOGICAL_ID = "742492b137e6ca0e09576c54528e4249017ccd55";

function app(deviceId: string, appName: string, logicalDeviceId?: string, udid?: string) {
  const deviceName = /\(([^)]*)\)$/.exec(appName)?.[1] ?? "";
  return { deviceId, appName, deviceName, logicalDeviceId, udid };
}

function appState(bundleId: string, active: boolean): NativeAppState {
  return {
    bundleId,
    applicationState: active ? "active" : "background",
    foregroundActiveSceneCount: active ? 1 : 0,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: active ? 0 : 1,
    unattachedSceneCount: 0,
    isFrontmostCandidate: active,
  };
}

function fakeNative(opts: {
  connected: string[];
  active?: string;
  query: (bundleId: string, params: Record<string, unknown> | undefined) => Promise<unknown>;
}) {
  const api = {
    listConnectedBundleIds: () => opts.connected,
    getAppState: async (bundleId: string) => appState(bundleId, bundleId === opts.active),
    queryViewHierarchy: vi.fn(
      (bundleId: string, _method: string, params?: Record<string, unknown>) =>
        opts.query(bundleId, params)
    ),
  } as unknown as NativeDevtoolsApi & { queryViewHierarchy: ReturnType<typeof vi.fn> };
  const registry = { resolveService: vi.fn(async (_urn: string, _options?: unknown) => api) };
  return { api, registry };
}

describe("readTapAxes", () => {
  afterEach(() => {
    vi.useRealTimers();
    simulators.list = [];
  });

  it("reads nothing for an Android device, whose touches use the window's axes", async () => {
    const { registry } = fakeNative({ connected: [], query: async () => ({}) });
    expect(
      await readTapAxes(registry as never, app("emulator-5554", "com.example.app"))
    ).toBeUndefined();
    expect(registry.resolveService).not.toHaveBeenCalled();
  });

  it("reads the orientation of the app the debugger is attached to", async () => {
    const { api, registry } = fakeNative({
      connected: ["com.example.other", "com.example.app"],
      query: async () => ({ windows: [], screen: { interfaceOrientation: "landscapeLeft" } }),
    });
    expect(
      await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone Duo)"))
    ).toBe("landscapeLeft");
    expect(api.queryViewHierarchy).toHaveBeenCalledWith(
      "com.example.app",
      "ViewHierarchy.getFullHierarchy",
      expect.objectContaining({ maxDepth: 1 })
    );
  });

  it("falls back to the frontmost connected app when no app matches the debugger's name", async () => {
    const { api, registry } = fakeNative({
      connected: ["com.example.a", "com.example.b"],
      active: "com.example.b",
      query: async () => ({ screen: { interfaceOrientation: "portrait" } }),
    });
    expect(await readTapAxes(registry as never, app(SIM_UDID, "My App (iPhone 16)"))).toBe(
      "portrait"
    );
    expect(api.queryViewHierarchy.mock.calls[0]?.[0]).toBe("com.example.b");
  });

  it("is unknown when the hierarchy names no orientation", async () => {
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: async () => ({ windows: [] }),
    });
    expect(await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))).toBe(
      "unknown"
    );
  });

  it("is unknown when the read fails", async () => {
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: async () => {
        throw new Error("Native devtools not connected for bundleId: com.example.app");
      },
    });
    expect(await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))).toBe(
      "unknown"
    );
  });

  it("is unknown when no app can be targeted", async () => {
    const { registry } = fakeNative({ connected: [], query: async () => ({}) });
    expect(await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))).toBe(
      "unknown"
    );
  });

  it("is unknown when the read does not answer in time", async () => {
    vi.useFakeTimers();
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: () => new Promise(() => {}),
    });
    const axes = readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await axes).toBe("unknown");
  });
  describe("a session keyed by its logicalDeviceId (two devices share one Metro)", () => {
    const landscape = async () => ({ screen: { interfaceOrientation: "landscapeRight" } });

    it("finds the booted iOS simulator by the debugger's device name", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone Duo", state: "Booted", runtimeKind: "mobile" },
        {
          udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
          name: "iPhone 18 Pro",
          state: "Booted",
          runtimeKind: "mobile",
        },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      const axes = await readTapAxes(
        registry as never,
        app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID)
      );
      expect(axes).toBe("landscapeRight");
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
        "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
      );
    });

    it("is ambiguous when two booted simulators share the name and no udid is given", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
        {
          udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
          name: "iPhone 18 Pro",
          state: "Booted",
          runtimeKind: "mobile",
        },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID)
        )
      ).toBe("ambiguous");
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    it("reads the simulator the udid names, whatever the names", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
        {
          udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
          name: "iPhone 18 Pro",
          state: "Booted",
          runtimeKind: "mobile",
        },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      const axes = await readTapAxes(
        registry as never,
        app(
          LOGICAL_ID,
          "com.example.app (iPhone 18 Pro)",
          LOGICAL_ID,
          "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
        )
      );
      expect(axes).toBe("landscapeRight");
      expect(registry.resolveService).toHaveBeenCalledTimes(1);
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
        "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
      );
    });

    it("is unknown when the udid names a simulator that does not run the debugged app", async () => {
      const { api, registry } = fakeNative({
        connected: ["com.example.other"],
        active: "com.example.other",
        query: landscape,
      });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, SIM_UDID)
        )
      ).toBe("unknown");
      expect(api.queryViewHierarchy).not.toHaveBeenCalled();
    });

    it("reads nothing when the udid names an Android device", async () => {
      const { registry } = fakeNative({ connected: [], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (Pixel 9)", LOGICAL_ID, "emulator-5554")
        )
      ).toBeUndefined();
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    it("reads nothing when no booted iOS simulator has the name (an Android device)", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone Duo", state: "Booted", runtimeKind: "mobile" },
      ];
      const { registry } = fakeNative({ connected: [], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (sdk_gphone64_arm64)", LOGICAL_ID)
        )
      ).toBeUndefined();
      expect(registry.resolveService).not.toHaveBeenCalled();
    });
  });
});

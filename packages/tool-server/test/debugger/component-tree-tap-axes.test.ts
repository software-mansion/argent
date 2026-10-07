import { afterEach, describe, expect, it, vi } from "vitest";

type ListedSimulator = { udid: string; name: string; state: string; runtimeKind: string };
const simulators = vi.hoisted(() => ({
  list: [] as ListedSimulator[],
  remote: [] as { udid: string; name: string; state: string }[],
}));
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  listIosSimulators: async () => simulators.list,
  findIosSimulator: async (udid: string) => simulators.list.find((s) => s.udid === udid),
}));
const remoteListing = vi.hoisted(() =>
  vi.fn(async (_options?: { timeoutMs?: number }) => ({
    devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": simulators.remote },
  }))
);
vi.mock("../../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/sim-remote")>()),
  simctlListDevices: remoteListing,
}));
import {
  buildTextTree,
  readTapAxes,
  type RawResult,
} from "../../src/tools/debugger/debugger-component-tree";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { rememberDeviceAlias, resetDeviceAliases } from "../../src/utils/debugger/device-alias";

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

  it("points to describe when two same-named simulators leave a landscape UI unread", () => {
    const text = buildTextTree(tree(LANDSCAPE, 0.8, 0.25), { ...base, uiOrientation: "ambiguous" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).toContain("two booted simulators have this device's name");
    expect(text).toContain(
      "Use describe for tap points, or call again with the udid of the simulator that shows this app."
    );
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

  it.each([
    ["landscape", LANDSCAPE],
    ["portrait", PORTRAIT],
  ])("says a udid that is not the app's simulator was not used, on a %s UI", (_shape, screen) => {
    const text = buildTextTree(tree(screen, 0.8, 0.25), { ...base, uiOrientation: "mismatched" });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).toContain(
      "Note: The udid is not the UDID of the simulator that shows this app. Thus, the tool did not use the udid."
    );
    expect(text).not.toContain("The UI is");
  });

  it.each([
    ["landscape", LANDSCAPE],
    ["portrait", PORTRAIT],
  ])("names the simulator read in place of the udid, on a %s UI", (_shape, screen) => {
    const text = buildTextTree(tree(screen, 0.8, 0.25), {
      ...base,
      uiOrientation: screen === LANDSCAPE ? "landscapeRight" : "portrait",
      readInsteadOfUdid: SIM_UDID,
    });
    expect(tapOf(text)).toBe(screen === LANDSCAPE ? "0.75,0.80" : "0.80,0.25");
    expect(text).toContain(
      `Note: the udid is not the UDID of the simulator that shows this app. The tool used ${SIM_UDID}, the UDID of that simulator.`
    );
  });

  it.each([
    ["a landscape UI", LANDSCAPE, "landscapeRight"],
    ["a portrait UI on a landscape simulator", PORTRAIT, "landscapeRight"],
    ["a landscape UI on a portrait simulator", LANDSCAPE, "portrait"],
  ] as const)("says a udid of a shared name could not be checked, on %s", (_case, screen, turn) => {
    const text = buildTextTree(tree(screen, 0.8, 0.25), {
      ...base,
      uiOrientation: turn,
      udidUnchecked: true,
    });
    expect(text).toContain(
      "Note: two booted simulators have this device's name, so the tool could not check that the udid is the simulator that shows this app."
    );
  });

  it("does not warn about an unchecked udid when the UI and the simulator are portrait", () => {
    const text = buildTextTree(tree(PORTRAIT, 0.8, 0.25), {
      ...base,
      uiOrientation: "portrait",
      udidUnchecked: true,
    });
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
    simulators.remote = [];
    remoteListing.mockClear();
  });

  it("reads nothing for an Android device, whose touches use the window's axes", async () => {
    const { registry } = fakeNative({ connected: [], query: async () => ({}) });
    expect(await readTapAxes(registry as never, app("emulator-5554", "com.example.app"))).toEqual(
      {}
    );
    expect(registry.resolveService).not.toHaveBeenCalled();
  });

  it("reads the orientation of the app the debugger is attached to", async () => {
    const { api, registry } = fakeNative({
      connected: ["com.example.other", "com.example.app"],
      query: async () => ({ windows: [], screen: { interfaceOrientation: "landscapeLeft" } }),
    });
    expect(
      await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone Duo)"))
    ).toEqual({ uiOrientation: "landscapeLeft" });
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
    expect(await readTapAxes(registry as never, app(SIM_UDID, "My App (iPhone 16)"))).toEqual({
      uiOrientation: "portrait",
    });
    expect(api.queryViewHierarchy.mock.calls[0]?.[0]).toBe("com.example.b");
  });

  it("is unknown when the hierarchy names no orientation", async () => {
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: async () => ({ windows: [] }),
    });
    expect(
      await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))
    ).toEqual({ uiOrientation: "unknown" });
  });

  it("is unknown when the read fails", async () => {
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: async () => {
        throw new Error("Native devtools not connected for bundleId: com.example.app");
      },
    });
    expect(
      await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))
    ).toEqual({ uiOrientation: "unknown" });
  });

  it("is unknown when no app can be targeted", async () => {
    const { registry } = fakeNative({ connected: [], query: async () => ({}) });
    expect(
      await readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"))
    ).toEqual({ uiOrientation: "unknown" });
  });

  it("is unknown when the read does not answer in time", async () => {
    vi.useFakeTimers();
    const { registry } = fakeNative({
      connected: ["com.example.app"],
      query: () => new Promise(() => {}),
    });
    const axes = readTapAxes(registry as never, app(SIM_UDID, "com.example.app (iPhone 16)"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await axes).toEqual({ uiOrientation: "unknown" });
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
      expect(axes).toEqual({ uiOrientation: "landscapeRight" });
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
      ).toEqual({ uiOrientation: "ambiguous" });
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    it("reads the udid among two of the app's device name, and says it could not be checked", async () => {
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
      expect(axes).toEqual({ uiOrientation: "landscapeRight", udidUnchecked: true });
      expect(registry.resolveService).toHaveBeenCalledTimes(1);
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
        "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
      );
    });

    it("is unknown when the udid names a simulator that does not run the debugged app", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
      ];
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
      ).toEqual({ uiOrientation: "unknown" });
      expect(api.queryViewHierarchy).not.toHaveBeenCalled();
    });

    it.each([
      ["another device's name", "iPhone Duo", "Booted"],
      ["the app's device name, but is shut down", "iPhone 18 Pro", "Shutdown"],
    ])(
      "reads the app's simulator in place of a udid whose simulator has %s",
      async (_case, name, state) => {
        simulators.list = [
          { udid: SIM_UDID, name, state, runtimeKind: "mobile" },
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
            app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, SIM_UDID)
          )
        ).toEqual({
          uiOrientation: "landscapeRight",
          readInsteadOfUdid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
        });
        expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
          "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
        );
      }
    );

    it("reads the app's simulator in place of a udid that no listing knows", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(
            LOGICAL_ID,
            "com.example.app (iPhone 18 Pro)",
            LOGICAL_ID,
            "00000000-0000-0000-0000-000000000000"
          )
        )
      ).toEqual({ uiOrientation: "landscapeRight", readInsteadOfUdid: SIM_UDID });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
    });

    it("is unknown when the simulator listing does not have the udid's simulator", async () => {
      // An empty listing is what a failed `simctl list` leaves.
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, SIM_UDID)
        )
      ).toEqual({ uiOrientation: "unknown" });
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    it.each([
      ["another simulator", "8BDBFD47-E557-41BA-926B-2DD39A17A53E"],
      ["an Android serial", "emulator-5554"],
    ])("does not read %s when two simulators have the app's device name", async (_case, udid) => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
        {
          udid: "A0D5E4C2-9E3A-4E7B-8F0C-2B1F6D7E9A11",
          name: "iPhone 18 Pro",
          state: "Booted",
          runtimeKind: "mobile",
        },
        {
          udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
          name: "iPhone Duo",
          state: "Booted",
          runtimeKind: "mobile",
        },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, udid)
        )
      ).toEqual({ uiOrientation: "mismatched" });
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    it("reads a remote simulator the udid names when sim-remote lists it by the app's name", async () => {
      simulators.remote = [{ udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted" }];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, `remote:${SIM_UDID}`)
        )
      ).toEqual({ uiOrientation: "landscapeRight" });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(`remote:${SIM_UDID}`);
      expect(remoteListing).toHaveBeenCalledWith({ timeoutMs: 3_000 });
    });

    it.each([
      [
        "another remote simulator",
        [],
        [{ udid: "A0D5E4C2-9E3A-4E7B-8F0C-2B1F6D7E9A11", name: "iPhone 18 Pro", state: "Booted" }],
      ],
      [
        "a local simulator",
        [
          {
            udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
            name: "iPhone 18 Pro",
            state: "Booted",
            runtimeKind: "mobile",
          },
        ],
        [],
      ],
    ])(
      "says a remote udid could not be checked when %s has the app's name",
      async (_case, local, remote) => {
        simulators.list = local;
        simulators.remote = [{ udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted" }, ...remote];
        const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
        expect(
          await readTapAxes(
            registry as never,
            app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, `remote:${SIM_UDID}`)
          )
        ).toEqual({ uiOrientation: "landscapeRight", udidUnchecked: true });
        expect(registry.resolveService.mock.calls[0]?.[0]).toContain(`remote:${SIM_UDID}`);
      }
    );

    it("reads the app's simulator in place of a remote simulator of another name", async () => {
      simulators.list = [
        {
          udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
          name: "iPhone 18 Pro",
          state: "Booted",
          runtimeKind: "mobile",
        },
      ];
      simulators.remote = [{ udid: SIM_UDID, name: "iPhone Duo", state: "Booted" }];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, `remote:${SIM_UDID}`)
        )
      ).toEqual({
        uiOrientation: "landscapeRight",
        readInsteadOfUdid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E",
      });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
        "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
      );
    });

    it("is unknown when sim-remote cannot list the remote udid", async () => {
      remoteListing.mockRejectedValueOnce(new Error("sim-remote: command not found"));
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (sdk_gphone64_arm64)", LOGICAL_ID, `remote:${SIM_UDID}`)
        )
      ).toEqual({ uiOrientation: "unknown" });
      expect(registry.resolveService).not.toHaveBeenCalled();
    });

    // debugger-connect takes any device_id for the one app on a Metro, so a
    // serial can key a session on an iOS simulator.
    it("reads a udid booted with the app's device name for a session connected with another device's serial", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app("emulator-5554", "com.example.app (iPhone 18 Pro)", undefined, SIM_UDID)
        )
      ).toEqual({ uiOrientation: "landscapeRight" });
      expect(registry.resolveService).toHaveBeenCalledTimes(1);
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
    });

    it.each([
      ["a session connected with its serial", "emulator-5554", undefined],
      ["a session keyed by its logicalDeviceId", LOGICAL_ID, LOGICAL_ID],
    ])(
      "ignores a simulator's udid for an app on Android, %s, with no note",
      async (_case, deviceId, logicalDeviceId) => {
        simulators.list = [
          { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
        ];
        const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
        expect(
          await readTapAxes(
            registry as never,
            app(deviceId, "com.example.app (sdk_gphone64_arm64)", logicalDeviceId, SIM_UDID)
          )
        ).toEqual({});
        expect(registry.resolveService).not.toHaveBeenCalled();
      }
    );

    it("reads the app's simulator in place of a udid that is no simulator", async () => {
      simulators.list = [
        { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
      ];
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, "emulator-5554")
        )
      ).toEqual({ uiOrientation: "landscapeRight", readInsteadOfUdid: SIM_UDID });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
    });

    it("reads nothing when the udid names an Android device", async () => {
      const { registry } = fakeNative({ connected: [], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(LOGICAL_ID, "com.example.app (Pixel 9)", LOGICAL_ID, "emulator-5554")
        )
      ).toEqual({});
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
      ).toEqual({});
      expect(registry.resolveService).not.toHaveBeenCalled();
    });
  });

  describe("a session connected with a simulator's UDID", () => {
    const landscape = async () => ({ screen: { interfaceOrientation: "landscapeRight" } });

    it("reads the simulator device_id names in place of another udid", async () => {
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
          app(
            SIM_UDID,
            "com.example.app (iPhone 18 Pro)",
            undefined,
            "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
          )
        )
      ).toEqual({ uiOrientation: "landscapeRight", readInsteadOfUdid: SIM_UDID });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
    });

    it.each([
      ["is shut down", { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Shutdown" }],
      ["has another name", { udid: SIM_UDID, name: "iPhone Duo", state: "Booted" }],
      ["is in no listing", undefined],
    ])(
      "reads a udid booted with the app's device name when the simulator device_id names %s",
      async (_case, own) => {
        simulators.list = [
          ...(own ? [{ ...own, runtimeKind: "mobile" }] : []),
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
            app(
              SIM_UDID,
              "com.example.app (iPhone 18 Pro)",
              undefined,
              "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
            )
          )
        ).toEqual({ uiOrientation: "landscapeRight" });
        expect(registry.resolveService).toHaveBeenCalledTimes(1);
        expect(registry.resolveService.mock.calls[0]?.[0]).toContain(
          "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
        );
      }
    );

    it.each([
      ["is shut down", "iPhone 18 Pro", "Shutdown"],
      ["has another name", "iPhone Duo", "Booted"],
    ])(
      "reads the simulator device_id names in place of a udid whose simulator %s",
      async (_case, name, state) => {
        simulators.list = [
          { udid: SIM_UDID, name: "iPhone 18 Pro", state: "Booted", runtimeKind: "mobile" },
          { udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E", name, state, runtimeKind: "mobile" },
        ];
        const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
        expect(
          await readTapAxes(
            registry as never,
            app(
              SIM_UDID,
              "com.example.app (iPhone 18 Pro)",
              undefined,
              "8BDBFD47-E557-41BA-926B-2DD39A17A53E"
            )
          )
        ).toEqual({ uiOrientation: "landscapeRight", readInsteadOfUdid: SIM_UDID });
        expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
      }
    );

    it("takes a forwarded logicalDeviceId for the simulator UDID it was connected with", async () => {
      rememberDeviceAlias(LOGICAL_ID, SIM_UDID);
      try {
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
        const session = (udid: string) =>
          readTapAxes(
            registry as never,
            app(LOGICAL_ID, "com.example.app (iPhone 18 Pro)", LOGICAL_ID, udid)
          );
        expect(await session("8BDBFD47-E557-41BA-926B-2DD39A17A53E")).toEqual({
          uiOrientation: "landscapeRight",
          readInsteadOfUdid: SIM_UDID,
        });
        expect(await session(SIM_UDID)).toEqual({ uiOrientation: "landscapeRight" });
        for (const [urn] of registry.resolveService.mock.calls) expect(urn).toContain(SIM_UDID);
      } finally {
        resetDeviceAliases();
      }
    });

    it("reads the simulator device_id names when the udid is the same one", async () => {
      const { registry } = fakeNative({ connected: ["com.example.app"], query: landscape });
      expect(
        await readTapAxes(
          registry as never,
          app(SIM_UDID, "com.example.app (iPhone 18 Pro)", undefined, SIM_UDID)
        )
      ).toEqual({ uiOrientation: "landscapeRight" });
      expect(registry.resolveService.mock.calls[0]?.[0]).toContain(SIM_UDID);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the device round-trip; keep REMOTE_BUTTONS real so the schema enum is genuine.
const injectVegaButtons = vi.fn();
vi.mock("../src/utils/vega-input", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/vega-input")>();
  return { ...actual, injectVegaButtons: (...a: unknown[]) => injectVegaButtons(...a) };
});

import { createTvRemoteTool } from "../src/tools/tv-remote";
import { UnsupportedOperationError } from "../src/utils/capability";
import type { TvControlApi } from "../src/blueprints/tv-control-types";

// resolveDevice is pure (shape-based), so real udids drive the platform branch.
const VEGA_UDID = "amazon-test01";
const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
const ANDROID_TV_SERIAL = "emulator-5556";

// A registry whose resolveService hands back a navigate spy for the focus-driven
// TV backends (Apple TV / Android TV). Vega never resolves a service — it injects
// over adb directly.
function makeRegistry() {
  const navigate = vi.fn().mockResolvedValue(undefined);
  const api = { navigate } as unknown as TvControlApi;
  const registry = { resolveService: vi.fn(async () => api) } as never;
  return { registry, navigate };
}

beforeEach(() => {
  injectVegaButtons.mockReset();
  injectVegaButtons.mockResolvedValue(undefined);
});

describe("tv-remote execute — Vega", () => {
  it("flattens `repeat` over a single button", async () => {
    const { registry } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: VEGA_UDID, button: "down", repeat: 3 }
    );
    expect(injectVegaButtons).toHaveBeenCalledWith(["down", "down", "down"]);
    expect(res).toEqual({ pressed: ["down", "down", "down"], count: 3 });
  });

  it("flattens `repeat` over a button path and reports the right count", async () => {
    const { registry } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: VEGA_UDID, button: ["up", "down"], repeat: 2 }
    );
    expect(injectVegaButtons).toHaveBeenCalledWith(["up", "down", "up", "down"]);
    expect(res).toEqual({ pressed: ["up", "down", "up", "down"], count: 4 });
  });

  it("defaults to a single press when no repeat is given", async () => {
    const { registry } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: VEGA_UDID, button: "select" }
    );
    expect(injectVegaButtons).toHaveBeenCalledWith(["select"]);
    expect(res.count).toBe(1);
  });

  it("supports Vega-only media/volume buttons", async () => {
    const { registry } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: VEGA_UDID, button: "volumeUp" }
    );
    expect(injectVegaButtons).toHaveBeenCalledWith(["volumeUp"]);
    expect(res.count).toBe(1);
  });
});

describe("tv-remote execute — Apple TV / Android TV (focus-driven)", () => {
  it("routes a D-pad path on Apple TV through the tv-control navigate", async () => {
    const { registry, navigate } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: TVOS_UDID, button: ["right", "select"] }
    );
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(["right", "select"]);
    expect(injectVegaButtons).not.toHaveBeenCalled();
    expect(res).toEqual({ pressed: ["right", "select"], count: 2 });
  });

  it("passes each remote button straight through to navigate on Android TV", async () => {
    const { registry, navigate } = makeRegistry();
    await createTvRemoteTool(registry).execute!(
      {},
      { udid: ANDROID_TV_SERIAL, button: ["back", "menu"] }
    );
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(["back", "menu"]);
  });

  it("supports media-transport / volume buttons on Android TV (real adb keyevents)", async () => {
    const { registry, navigate } = makeRegistry();
    const res = await createTvRemoteTool(registry).execute!(
      {},
      { udid: ANDROID_TV_SERIAL, button: ["fastForward", "volumeUp", "mute"] }
    );
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(["fastForward", "volumeUp", "mute"]);
    expect(res).toEqual({ pressed: ["fastForward", "volumeUp", "mute"], count: 3 });
  });

  it("rejects inert media / volume buttons on Apple TV without pressing anything", async () => {
    const { registry, navigate } = makeRegistry();
    await expect(
      createTvRemoteTool(registry).execute!({}, { udid: TVOS_UDID, button: ["right", "volumeUp"] })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    // Whole path rejected up front — no partial execution.
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("tv-remote button schema", () => {
  const schema = createTvRemoteTool({} as never).zodSchema!;

  it("coerces a JSON-array string back to an array", () => {
    expect(schema.parse({ udid: "x", button: '["up","down"]' }).button).toEqual(["up", "down"]);
  });

  it("coerces a comma-separated string back to an array", () => {
    expect(schema.parse({ udid: "x", button: "up, down" }).button).toEqual(["up", "down"]);
  });

  it("keeps a single button as a scalar", () => {
    expect(schema.parse({ udid: "x", button: "select" }).button).toBe("select");
  });

  it("rejects an unknown button and an empty path", () => {
    expect(() => schema.parse({ udid: "x", button: "nope" })).toThrow();
    expect(() => schema.parse({ udid: "x", button: [] })).toThrow();
  });
});

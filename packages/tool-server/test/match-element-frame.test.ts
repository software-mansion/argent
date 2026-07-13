/**
 * Server-side element-frame matcher used by `propose_variant` to auto-capture
 * each variant's crop frame at propose time (so every variant crops to its own
 * on-screen layout instead of inheriting the first variant's frozen frame —
 * the "first thumbnail right, the rest mis-cropped" bug).
 *
 * `matchFrameInTree` must mirror the preview UI's `vpMatchNode`: normalize the
 * same way, prefer the smallest sane on-screen box, ignore full-screen
 * containers.
 */
import { describe, it, expect, vi } from "vitest";
import type { Registry } from "@argent/registry";

vi.mock("../src/tools/describe/platforms/ios", () => ({ describeIos: vi.fn() }));
vi.mock("../src/tools/describe/platforms/android", () => ({ describeAndroid: vi.fn() }));
vi.mock("../src/utils/device-info", () => ({
  resolveDevice: (udid: string) => ({ id: udid, platform: "ios", kind: "simulator" }),
}));
// captureElementFrame probes isTvOsSimulator() — a real `xcrun simctl list`
// that never caches for a fake UDID, so it re-runs per call and takes seconds
// under the parallel suite load. Pin it; the rest of the module stays real.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});

import { describeIos } from "../src/tools/describe/platforms/ios";
import { matchFrameInTree, captureElementFrame } from "../src/utils/match-element-frame";

const mockedIos = describeIos as unknown as ReturnType<typeof vi.fn>;

// A small tree: a full-screen root containing a header group, a title label,
// and a button. The title and button are the realistic match targets.
const TREE = {
  role: "AXGroup",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    {
      role: "AXGroup",
      frame: { x: 0, y: 0.05, width: 1, height: 0.12 }, // header container
      children: [
        {
          role: "StaticText",
          label: "Favourites",
          frame: { x: 0.04, y: 0.07, width: 0.5, height: 0.04 },
          children: [],
        },
        {
          role: "Button",
          label: "Export",
          identifier: "export-btn",
          frame: { x: 0.7, y: 0.07, width: 0.25, height: 0.05 },
          children: [],
        },
      ],
    },
  ],
};

describe("matchFrameInTree", () => {
  it("text match returns the matched element's frame (not a container)", () => {
    const f = matchFrameInTree(TREE as never, { by: "text", value: "Favourites" });
    expect(f).toEqual({ x: 0.04, y: 0.07, width: 0.5, height: 0.04 });
  });

  it("identifier match is exact", () => {
    const f = matchFrameInTree(TREE as never, { by: "identifier", value: "export-btn" });
    expect(f).toEqual({ x: 0.7, y: 0.07, width: 0.25, height: 0.05 });
  });

  it("label match resolves the button by its accessibility label", () => {
    const f = matchFrameInTree(TREE as never, { by: "label", value: "Export" });
    expect(f).toEqual({ x: 0.7, y: 0.07, width: 0.25, height: 0.05 });
  });

  it("ignores near-full-screen container matches", () => {
    // A tree whose only 'menu' match spans the whole screen → treated as a
    // container, not the target → no frame.
    const big = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      label: "menu",
      children: [],
    };
    expect(matchFrameInTree(big as never, { by: "label", value: "menu" })).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchFrameInTree(TREE as never, { by: "text", value: "nope" })).toBeNull();
  });
});

describe("captureElementFrame", () => {
  const registry = {} as Registry;

  it("describes the device and returns the matched frame", async () => {
    mockedIos.mockResolvedValue({ tree: TREE, source: "ax-service" });
    const f = await captureElementFrame(registry, "UDID-1", { by: "text", value: "Favourites" });
    expect(f).toEqual({ x: 0.04, y: 0.07, width: 0.5, height: 0.04 });
  });

  it("returns null (best-effort) when describe throws", async () => {
    mockedIos.mockRejectedValue(new Error("ax-service timed out"));
    const f = await captureElementFrame(registry, "UDID-1", { by: "text", value: "Favourites" });
    expect(f).toBeNull();
  });

  it("returns null when the describe tree has no match (e.g. empty AX tree)", async () => {
    mockedIos.mockResolvedValue({
      tree: { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
      source: "ax-service",
    });
    // attempts: 1 — skip the warm-up retry budget; here we only assert that a
    // single describe with no match yields null.
    const f = await captureElementFrame(
      registry,
      "UDID-1",
      { by: "text", value: "Favourites" },
      { attempts: 1 }
    );
    expect(f).toBeNull();
  });
});

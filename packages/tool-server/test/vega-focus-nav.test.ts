import { describe, it, expect } from "vitest";
import { nextFocus, pathTo, type Focusable } from "../src/tools/describe/platforms/vega/focus-nav";

// Ground truth captured on a real Vega Virtual Device (SDK 0.23.8128) by driving
// inputd-cli D-pad presses against a controlled grid of absolutely-positioned
// focusables and reading the resulting `[focused]` element from the on-device
// automation toolkit. Pixel bounds are exactly as rendered (no normalization).
const r = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const GRID: Focusable[] = [
  { id: "S", rect: r(860, 480, 200, 120) },
  { id: "A", rect: r(860, 900, 200, 120) },
  { id: "B", rect: r(560, 700, 200, 120) },
  { id: "C", rect: r(1500, 480, 200, 120) },
  { id: "E", rect: r(860, 120, 200, 120) },
];

// Every non-no-op transition observed on hardware (12/12 reproduced by the model).
const VERIFIED: [string, "up" | "down" | "left" | "right", string][] = [
  ["A", "up", "B"], // discriminator: unweighted euclid would pick S; device picked B
  ["A", "left", "B"],
  ["A", "right", "C"],
  ["E", "down", "S"],
  ["E", "left", "B"],
  ["E", "right", "C"],
  ["C", "up", "E"],
  ["C", "down", "B"], // discriminator: unweighted euclid would pick A; device picked B
  ["C", "left", "S"],
  ["B", "up", "S"],
  ["B", "down", "A"],
  ["B", "right", "A"],
];

describe("vega focus-nav — reproduces device-verified transitions", () => {
  for (const [from, dir, expected] of VERIFIED) {
    it(`${from} --${dir}--> ${expected}`, () => {
      expect(nextFocus(dir, from, GRID)).toBe(expected);
    });
  }

  it("no-op presses (no candidate in direction) return null", () => {
    expect(nextFocus("down", "A", GRID)).toBeNull(); // A is the bottom box
    expect(nextFocus("up", "E", GRID)).toBeNull(); // E is the top box
    expect(nextFocus("right", "C", GRID)).toBeNull(); // C is the right box
    expect(nextFocus("left", "B", GRID)).toBeNull(); // B is the left box
  });

  it("the two weight discriminators exclude the unweighted (K=1) model", () => {
    // A-up: S is directly above (major 300, minor 0); B is near-above, off-axis
    // (major 80, minor 300). Unweighted picks S; the device + model pick B.
    expect(nextFocus("up", "A", GRID)).toBe("B");
    // C-down: A is near, off-axis a lot; B is the device's pick under major-weight.
    expect(nextFocus("down", "C", GRID)).toBe("B");
  });
});

describe("vega focus-nav — pathTo (BFS over the static focus graph)", () => {
  it("finds a press sequence and every step is a real transition", () => {
    const path = pathTo("E", "A", GRID);
    expect(path).not.toBeNull();
    let cur = "A";
    for (const dir of path!) cur = nextFocus(dir, cur, GRID)!;
    expect(cur).toBe("E");
  });

  it("returns [] for the trivial path and reaches every node from S", () => {
    expect(pathTo("S", "S", GRID)).toEqual([]);
    for (const f of GRID) {
      const p = pathTo(f.id, "S", GRID);
      expect(p, `reach ${f.id}`).not.toBeNull();
    }
  });
});

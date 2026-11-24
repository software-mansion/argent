import { describe, expect, it } from "vitest";
import { buildTextTree, type RawResult } from "../../src/tools/debugger/debugger-component-tree";

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

// The layout rects are in the window's axes, which turn with the UI, and the
// gesture tools take the UI's upright space on every platform (on an iOS
// simulator `sendCommand` turns a touch into the native space). So a tap
// point is the rect's centre in the window, whichever way the UI lies.
describe("buildTextTree — tap points in the UI's upright space", () => {
  it.each([
    ["a landscape UI", LANDSCAPE],
    ["a portrait UI", PORTRAIT],
  ])("is the window-normalized centre on %s", (_name, screen) => {
    const text = buildTextTree(tree(screen, 0.8, 0.25), { onScreenOnly: true });
    expect(tapOf(text)).toBe("0.80,0.25");
    expect(text).toContain(`Screen: ${screen.screenW}x${screen.screenH}`);
    expect(text).not.toContain("Note:");
  });
});

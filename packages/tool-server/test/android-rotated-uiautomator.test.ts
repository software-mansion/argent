import { describe, it, expect } from "vitest";
import { orientScreenSize, parseDumpRotation } from "../src/utils/android-screen";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";

/**
 * Issue #609, legacy describe path. `wm size` reports the UNROTATED size —
 * measured on a landscape Pixel_9 (API 36) whose display was really 2424x1080,
 * `wm size` still answered "Physical size: 1080x2424" with no Override line.
 *
 * uiautomator, by contrast, reports bounds against the rotated display. Dividing
 * one by the other did not merely squash the frames: nodes whose left edge lies
 * past the (too small) screen width are treated as off-screen and pruned, so the
 * right-hand half of a landscape screen vanished from the tree entirely.
 *
 * The dump states its own rotation, so the divisor can be oriented with no extra
 * round-trip — which matters because this path runs exactly when the
 * android-devtools helper could not be reached.
 */

/** Shaped like a real landscape dump: 2424x1080, with content past x=1080. */
const LANDSCAPE_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][2424,1080]">
    <node index="0" text="Left edge" resource-id="id/left" class="android.widget.TextView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[24,100][500,200]" />
    <node index="1" text="Right edge" resource-id="id/right" class="android.widget.TextView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1900,100][2380,200]" />
  </node>
</hierarchy>`;

const PORTRAIT_DUMP = LANDSCAPE_DUMP.replace('rotation="1"', 'rotation="0"');

/** Every label anywhere in the tree. uiautomator `text` surfaces as `label`. */
function labels(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: Record<string, unknown>) => {
    if (typeof n.label === "string" && n.label) out.push(n.label);
    for (const c of (n.children as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  walk(node as Record<string, unknown>);
  return out;
}

function findFrame(node: unknown, text: string): { x: number; width: number } | undefined {
  let found: { x: number; width: number } | undefined;
  const walk = (n: Record<string, unknown>) => {
    if (n.label === text && n.frame) found = n.frame as { x: number; width: number };
    for (const c of (n.children as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  walk(node as Record<string, unknown>);
  return found;
}

describe("parseDumpRotation", () => {
  it("reads the rotation the dump was taken at", () => {
    expect(parseDumpRotation(LANDSCAPE_DUMP)).toBe(1);
    expect(parseDumpRotation(PORTRAIT_DUMP)).toBe(0);
  });

  it("reads every rotation the platform can report", () => {
    for (const r of [0, 1, 2, 3]) {
      expect(parseDumpRotation(`<hierarchy rotation="${r}"><node /></hierarchy>`)).toBe(r);
    }
  });

  it("returns null when the attribute is absent, so older dumps still work", () => {
    expect(parseDumpRotation("<hierarchy><node /></hierarchy>")).toBeNull();
  });

  it("returns null for an unparseable value rather than guessing", () => {
    expect(parseDumpRotation('<hierarchy rotation="x"><node /></hierarchy>')).toBeNull();
  });
});

describe("orientScreenSize", () => {
  const portrait = { width: 1080, height: 2424 };

  it("swaps the axes when the device is on its side", () => {
    expect(orientScreenSize(portrait, 1)).toEqual({ width: 2424, height: 1080 });
    expect(orientScreenSize(portrait, 3)).toEqual({ width: 2424, height: 1080 });
  });

  it("leaves an upright or upside-down device alone", () => {
    expect(orientScreenSize(portrait, 0)).toEqual(portrait);
    expect(orientScreenSize(portrait, 2)).toEqual(portrait);
  });

  it("leaves the size alone when the rotation is unknown", () => {
    expect(orientScreenSize(portrait, null)).toEqual(portrait);
  });
});

describe("a rotated dump normalized against the oriented size", () => {
  const wmSize = { width: 1080, height: 2424 }; // what `wm size` really answers

  it("drops the right-hand half of the screen when the size is not oriented", () => {
    // This is the bug, stated as a test: with the unrotated divisor the node at
    // x=1900 is past screenW=1080 and is pruned as off-screen, so it is missing
    // from the tree entirely — not merely clamped.
    const tree = parseUiAutomatorDump(LANDSCAPE_DUMP, wmSize.width, wmSize.height);
    expect(labels(tree)).toContain("Left edge");
    expect(labels(tree)).not.toContain("Right edge");
  });

  it("keeps both edges once the size is oriented by the dump's own rotation", () => {
    const oriented = orientScreenSize(wmSize, parseDumpRotation(LANDSCAPE_DUMP));
    const tree = parseUiAutomatorDump(LANDSCAPE_DUMP, oriented.width, oriented.height);
    expect(labels(tree)).toEqual(expect.arrayContaining(["Left edge", "Right edge"]));
  });

  it("puts the right-hand node where it actually is on screen", () => {
    const oriented = orientScreenSize(wmSize, parseDumpRotation(LANDSCAPE_DUMP));
    const tree = parseUiAutomatorDump(LANDSCAPE_DUMP, oriented.width, oriented.height);
    const frame = findFrame(tree, "Right edge")!;
    // 1900/2424 ≈ 0.784 — on the right-hand side, which is the whole point.
    expect(frame.x).toBeCloseTo(1900 / 2424, 2);
    expect(frame.width).toBeCloseTo(480 / 2424, 2);
  });

  it("leaves an unrotated dump exactly as it was", () => {
    const oriented = orientScreenSize(wmSize, parseDumpRotation(PORTRAIT_DUMP));
    expect(oriented).toEqual(wmSize);
  });
});

import { describe, it, expect } from "vitest";
import { buildVideoFilter } from "../src/tools/screen-recording/finish-recording";

describe("finish-recording video filter", () => {
  it("always normalizes to a constant 30fps", () => {
    expect(buildVideoFilter(false)).toBe("fps=30");
    expect(buildVideoFilter(true)).toMatch(/^fps=30,/);
  });

  it("omits the watermark when disabled", () => {
    expect(buildVideoFilter(false)).not.toContain("drawbox");
  });

  it("overlays the watermark in the bottom-left when enabled", () => {
    const vf = buildVideoFilter(true);
    // two drawbox passes: translucent fill + a lighter border, both anchored to
    // the bottom-left corner and sized relative to the frame width.
    const boxes = vf.match(/drawbox=/g) ?? [];
    expect(boxes).toHaveLength(2);
    expect(vf).toContain("x=iw*0.03");
    expect(vf).toContain("y=ih-iw*0.16-iw*0.03");
    expect(vf).toContain("color=black@0.35:t=fill");
    expect(vf).toContain("color=white@0.5:t=3");
  });
});

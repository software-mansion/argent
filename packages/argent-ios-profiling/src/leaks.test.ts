import { describe, it, expect } from "vitest";
import { parseLeakLines } from "./leaks";

// Verbatim ROOT-LEAK lines from `xcrun simctl spawn <udid> leaks <pid>`
// (ParadiseGallery on a real iOS 26.5 sim).
const SAMPLE = `Process 39640: 13 leaks for 2928 total leaked bytes.
      9 (1.25K) ROOT LEAK: <NSMutableDictionary 0x10ca9ce80> [32]  item count: 3
      1 (1.00K) ROOT LEAK: 0x106657000 [1024]  length: 34  "reanimated::NativeReanimatedModule"
      1 (384 bytes) ROOT LEAK: <CFString 0x105d77c00> [384]  length: 333  "RCTFatalException: ..."
      1 (224 bytes) ROOT LEAK: <CFString 0x105cbb1e0> [224]  length: 178  "Unable to resolve ..."
      1 (16 bytes) ROOT LEAK: 0x1202b7d20 [16]
`;

describe("parseLeakLines", () => {
  const rows = parseLeakLines(SAMPLE);

  it("captures every ROOT LEAK, including untyped raw-malloc blocks", () => {
    // 5 ROOT LEAK lines — the two untyped (`0x… [n]`) ones used to be dropped.
    expect(rows).toHaveLength(5);
  });

  it("uses the PER-OBJECT bracket size, not the group total", () => {
    const dict = rows.find((r) => r.type === "NSMutableDictionary")!;
    // group total is 1.25K (1280B) for the retained subgraph; per-object is [32].
    expect(dict.size).toBe(32);
    expect(dict.count).toBe(9);
  });

  it("labels untyped blocks by their string hint, else by Malloc size", () => {
    expect(rows.find((r) => r.size === 1024)?.type).toBe("reanimated::NativeReanimatedModule");
    expect(rows.find((r) => r.size === 16)?.type).toBe("Malloc 16 bytes");
  });

  it("keeps module-qualified type names intact (no truncation at `.`/`:`)", () => {
    // would have been truncated to "reanimated" by the old [A-Za-z_]\w* regex.
    expect(rows.some((r) => r.type.includes("::"))).toBe(true);
  });

  it("ignores non-leak lines", () => {
    expect(parseLeakLines("Process 1: 0 leaks for 0 total leaked bytes.\n")).toHaveLength(0);
  });
});

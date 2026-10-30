import { describe, expect, it, vi, beforeEach } from "vitest";
import { harmonyDisplay, harmonyDumpLayout } from "../src/utils/harmony-uitest";
import { describeHarmony } from "../src/tools/describe/platforms/harmony";
import { formatDescribeTree } from "../src/tools/describe/format-tree";

vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyDisplay: vi.fn(),
  harmonyDumpLayout: vi.fn(),
}));

const CONNECT_KEY = "025DEK236V035771";

function lockScreenDump() {
  return {
    attributes: { bounds: "[0,0][1216,2688]" },
    children: [
      {
        attributes: {
          type: "WindowScene",
          bundleName: "com.ohos.sceneboard",
          bounds: "[0,107][1216,2688]",
        },
        children: [{ attributes: { type: "Text", text: "04:39", bounds: "[300,900][900,1200]" } }],
      },
      {
        attributes: {
          type: "WindowScene",
          bundleName: "com.ohos.sceneboard",
          bounds: "[0,0][1216,188]",
        },
        children: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(harmonyDumpLayout).mockReset();
  vi.mocked(harmonyDisplay).mockReset();
});

describe("describeHarmony", () => {
  it("warns that the panel is off even though the dump still lists windows", async () => {
    // A suspended panel still dumps both windows.
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: false });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const result = await describeHarmony(CONNECT_KEY);

    expect(result.tree.children.length).toBeGreaterThan(0);
    expect(result.hint).toMatch(/display is off/);
  });

  it("blames the panel, not a slow app, when the screen is off AND nothing dumped", async () => {
    // On a panel that is off, describe-again or screenshot never resolves, so wake comes first.
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: false });
    vi.mocked(harmonyDumpLayout).mockResolvedValue({
      attributes: { bounds: "[0,0][1216,2688]" },
      children: [],
    });

    const result = await describeHarmony(CONNECT_KEY);

    expect(result.hint).toMatch(/display is off/);
    expect(result.hint).not.toMatch(/no windows/);
  });

  it("says nothing extra when the screen is on and the dump has windows", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    expect((await describeHarmony(CONNECT_KEY)).hint).toBeUndefined();
  });

  it("points at a still-starting app when the screen is on but no window dumped", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue({
      attributes: { bounds: "[0,0][1216,2688]" },
      children: [],
    });

    expect((await describeHarmony(CONNECT_KEY)).hint).toMatch(/no windows/);
  });

  it("renders through the nested formatter, so elements inside a window survive", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const { tree, source } = await describeHarmony(CONNECT_KEY);
    const out = formatDescribeTree(tree, { source });

    expect(out).toContain("Source: harmony-uitest");
    expect(out).toContain("Mode: nested");
    expect(out).toContain("04:39");
  });

  it("offers exactly the gestures this platform has a backend for", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const { tree, source } = await describeHarmony(CONNECT_KEY);
    const out = formatDescribeTree(tree, { source });

    expect(out).toContain("gesture-tap / gesture-swipe / gesture-pinch");
    expect(out).not.toContain("gesture-rotate");
    expect(out).not.toContain("gesture-custom");
  });

  it("spends one budget across the panel read and the dump, not one apiece", async () => {
    // Both legs share the caller's remaining budget.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const PANEL_MS = 400;
      vi.mocked(harmonyDisplay).mockImplementation(async () => {
        vi.setSystemTime(Date.now() + PANEL_MS);
        return { width: 1216, height: 2688, screenOn: true };
      });
      vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

      await describeHarmony(CONNECT_KEY, 3_000);

      expect(vi.mocked(harmonyDumpLayout).mock.calls[0][2]).toBe(3_000 - PANEL_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

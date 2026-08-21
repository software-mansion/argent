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

/** The two `com.ohos.sceneboard` windows a Mate 60 dumps on its lock screen. */
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
    // Measured on a suspended Mate 60: `powerStatus=POWER_STATUS_SUSPEND` still
    // dumps both sceneboard windows, so the tree alone cannot be told apart
    // from a live screen — and every tap injected against it is a silent no-op.
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: false });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const result = await describeHarmony(CONNECT_KEY);

    expect(result.tree.children.length).toBeGreaterThan(0);
    expect(result.hint).toMatch(/display is off/);
  });

  it("blames the panel, not a slow app, when the screen is off AND nothing dumped", async () => {
    // The one case the two hints both claim. Telling the caller to describe
    // again or take a screenshot is a loop that never resolves on a panel that
    // is off, and the screenshot comes back a stale frame (#792) — so the wake
    // has to come first.
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

  // `uitest dumpLayout` is a real parent/child tree, so the flat renderer would
  // keep only the windows and drop every element inside them. Rendering what
  // describeHarmony actually returns pins the source string and the renderer
  // condition together: changing either loses the clock line below.
  it("renders through the nested formatter, so elements inside a window survive", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const { tree, source } = await describeHarmony(CONNECT_KEY);
    const out = formatDescribeTree(tree, { source });

    expect(out).toContain("Source: harmony-uitest");
    expect(out).toContain("Mode: nested");
    expect(out).toContain("04:39");
  });

  it("does not offer the agent a gesture this platform has no backend for", async () => {
    // `gesture-pinch` declares no `harmony` capability, so it refuses the device
    // — a header naming it costs the agent a round trip into a 400 with nothing
    // to fall back to. The two it does name must stay named.
    vi.mocked(harmonyDisplay).mockResolvedValue({ width: 1216, height: 2688, screenOn: true });
    vi.mocked(harmonyDumpLayout).mockResolvedValue(lockScreenDump());

    const { tree, source } = await describeHarmony(CONNECT_KEY);
    const out = formatDescribeTree(tree, { source });

    expect(out).not.toContain("gesture-pinch");
    expect(out).toContain("gesture-tap / gesture-swipe");
  });

  it("spends one budget across the panel read and the dump, not one apiece", async () => {
    // A wait tool hands this the time left before ITS deadline, so two legs each
    // taking the whole of it is a read that runs to twice the caller's budget —
    // and past the MCP client's 30s abort, which replays the call while the
    // abandoned `uitest` keeps holding the device's queue. The clock is frozen
    // so the only thing moving it is the panel read.
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

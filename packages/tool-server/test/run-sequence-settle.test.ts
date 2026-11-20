import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../src/tools/describe/contract";

const readTree = vi.fn<() => Promise<DescribeTreeData>>();

vi.mock("../src/tools/describe/platforms/ios", () => ({ describeIos: () => readTree() }));
vi.mock("../src/tools/flows/flow-android-tree", () => ({
  queryAndroidFullHierarchy: () => readTree(),
}));
vi.mock("../src/tools/flows/flow-chromium-tree", () => ({
  queryChromiumTree: () => readTree(),
}));

import { createRunSequenceTool } from "../src/tools/run-sequence";

const IOS_SIMULATOR = "11111111-1111-1111-1111-111111111111";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const HARMONY = "harmony-025DEK236V035771";
const PHYSICAL_IPHONE = "00008110-000000000000001E";
const IOS_REMOTE = "remote:AAAA";

const sheetAt = (y: number): DescribeTreeData => ({
  source: "ax-service",
  tree: {
    role: "Application",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      {
        role: "Button",
        label: "Maybe later",
        frame: { x: 0, y, width: 1, height: 0.1 },
        children: [],
      },
    ],
  },
});

let log: string[];

function recordingRegistry(): Registry {
  return {
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (id: string) => {
      log.push(id);
      return { success: true };
    }),
  } as unknown as Registry;
}

function treeSequence(...trees: DescribeTreeData[]): void {
  let i = 0;
  readTree.mockImplementation(async () => {
    log.push("read");
    return trees[Math.min(i++, trees.length - 1)]!;
  });
}

const tap = { tool: "gesture-tap", args: { x: 0.5, y: 0.9 }, delayMs: 0 };

async function run(udid: string, steps: object[], settle?: boolean): Promise<void> {
  const tool = createRunSequenceTool(recordingRegistry());
  await tool.execute({}, { udid, steps, ...(settle === undefined ? {} : { settle }) } as never);
}

beforeEach(() => {
  log = [];
  readTree.mockReset();
  treeSequence(sheetAt(0.9));
});

describe("run-sequence settle", () => {
  it.each([IOS_SIMULATOR, ANDROID, CHROMIUM])(
    "holds the next step on %s until two reads match",
    async (udid) => {
      treeSequence(sheetAt(0.9), sheetAt(0.6), sheetAt(0.5), sheetAt(0.5));

      await run(udid, [tap, tap]);

      expect(log).toEqual(["gesture-tap", "read", "read", "read", "read", "gesture-tap"]);
    }
  );

  it("waits after enter, escape and a submitted text, not after other keys or text", async () => {
    const key = (k: string) => ({ tool: "keyboard", args: { key: k }, delayMs: 0 });
    const text = (t: string) => ({ tool: "keyboard", args: { text: t }, delayMs: 0 });

    await run(IOS_SIMULATOR, [
      key("Enter"),
      key("return"),
      key("escape"),
      key("esc"),
      text("query\n"),
      text("a\r"),
      key("backspace"),
      text("plain"),
      tap,
    ]);

    expect(log).toEqual([
      ...Array(6).fill(["keyboard", "read", "read"]).flat(),
      "keyboard",
      "keyboard",
      "gesture-tap",
    ]);
  });

  it("waits after a met await-ui-element and a button, not after a swipe, before an await-ui-element or after the last step", async () => {
    const awaitElement = { tool: "await-ui-element", args: {}, delayMs: 0 };

    await run(ANDROID, [
      awaitElement,
      { tool: "button", args: { button: "back" }, delayMs: 0 },
      { tool: "gesture-swipe", args: {}, delayMs: 0 },
      tap,
      awaitElement,
      tap,
      tap,
    ]);

    expect(log).toEqual([
      ...["await-ui-element", "read", "read"],
      ...["button", "read", "read"],
      "gesture-swipe",
      "gesture-tap",
      ...["await-ui-element", "read", "read"],
      ...["gesture-tap", "read", "read"],
      "gesture-tap",
    ]);
  });

  it("skips the wait with settle: false and on targets without a fast tree read", async () => {
    await run(IOS_SIMULATOR, [tap, tap], false);
    for (const udid of [PHYSICAL_IPHONE, IOS_REMOTE, HARMONY]) await run(udid, [tap, tap]);

    expect(log).toEqual(Array(8).fill("gesture-tap"));
  });

  it("ends the wait on a failed read", async () => {
    readTree.mockImplementation(async () => {
      log.push("read");
      throw new Error("Target closed");
    });

    await run(CHROMIUM, [tap, tap]);

    expect(log).toEqual(["gesture-tap", "read", "gesture-tap"]);
  });

  it.each([
    ["a read", 50, () => new Promise<DescribeTreeData>(() => {})],
    ["the poll sleep", 10, async () => sheetAt(0.9)],
  ])("stops at once when the call is aborted during %s", async (_case, abortAfterMs, read) => {
    const controller = new AbortController();
    readTree.mockImplementation(() => {
      log.push("read");
      setTimeout(() => controller.abort(), abortAfterMs);
      return read();
    });
    const tool = createRunSequenceTool(recordingRegistry());

    const started = Date.now();
    await tool.execute(
      {},
      { udid: IOS_SIMULATOR, steps: [tap, tap] } as never,
      {
        signal: controller.signal,
      } as never
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(log).toEqual(["gesture-tap", "read"]);
  });

  let reads = 0;
  it.each([
    ["the tree keeps changing", () => sheetAt(reads++ % 2)],
    ["a read never returns", () => new Promise<DescribeTreeData>(() => {})],
  ])("moves on after about a second when %s", async (_case, read) => {
    readTree.mockImplementation(async () => read());

    const started = Date.now();
    await run(IOS_SIMULATOR, [tap, tap]);
    const elapsed = Date.now() - started;

    expect(log).toEqual(["gesture-tap", "gesture-tap"]);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1500);
  });
});

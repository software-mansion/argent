import { describe, expect, it } from "vitest";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MACOS_DEVICE_ID,
  fakeMacosLibrary,
  findWireNode,
  macosRegistry,
  probeTree,
  rect,
  webTree,
  windowRoot,
} from "./helpers/macos-tree-fixture";

useMacosAppsFlag();

type LibraryOpts = Parameters<typeof fakeMacosLibrary>[0];

async function awaitElement(opts: LibraryOpts, params: Record<string, unknown>) {
  const lib = fakeMacosLibrary(opts);
  const tool = createAwaitUiElementTool(macosRegistry(lib.api));
  const result = await tool.execute({}, {
    udid: MACOS_DEVICE_ID,
    timeoutMs: 500,
    pollIntervalMs: 50,
    ...params,
  } as Parameters<typeof tool.execute>[1]);
  return { result, lib, tool };
}

describe("await-ui-element on a Mac app", () => {
  it("polls the in-app library's tree, not a Chromium session", async () => {
    // No services: a call that reached the Chromium fallthrough would throw on
    // `services.chromium`.
    const { result, lib, tool } = await awaitElement(
      {},
      { selector: { identifier: "web-button" }, condition: "visible", timeoutMs: 2000 }
    );
    expect(tool.capability?.macos).toEqual({ app: true });
    expect(result).toMatchObject({ success: true });
    expect(lib.calls[0]!.method).toBe("Accessibility.getTree");
  });

  it("reads a scroll-hidden row as hidden", async () => {
    const { result } = await awaitElement(
      {},
      { selector: { text: "row 12" }, condition: "hidden" }
    );
    expect(result.success).toBe(true);
  });

  it("waits for a value the app changes between reads", async () => {
    const before = probeTree();
    const after = probeTree();
    findWireNode(windowRoot(after), (n) => n.value === "taps 0")!.value = "taps 1";
    const { result, lib } = await awaitElement(
      { trees: [before, before, after] },
      {
        selector: { text: "taps" },
        condition: "text",
        expectedText: "taps 1",
        timeoutMs: 2000,
        pollIntervalMs: 20,
      }
    );
    expect(result.success).toBe(true);
    expect(lib.calls.filter((c) => c.method === "Accessibility.getTree").length).toBe(3);
  });

  it.each([
    [
      "lost the web view's content",
      { web: new Error("Web.tree timed out") },
      "web-button",
      /could not read the web content/,
    ],
    // The dead element is the one the wait is about: it is missing from the read.
    [
      "has elements that did not answer",
      { trees: [probeTree({ dead: true })] },
      "swift.dead",
      /is incomplete: 1 element\(s\) did not answer/,
    ],
    // The fallback walk misses an open context menu.
    [
      "came from the fallback walk",
      { trees: [{ ...probeTree(), source: "fallback", locked: true }] },
      "context.copy",
      /could not confirm the element is hidden.*The Mac is locked/,
    ],
  ])("does not pass `hidden` on a read that %s", async (_name, opts, identifier, note) => {
    const { result, lib } = await awaitElement(opts, {
      selector: { identifier },
      condition: "hidden",
      timeoutMs: 600,
    });
    expect(result.success).toBe(false);
    expect(result.note).toMatch(note);
    expect(lib.calls[0]!.params).toEqual({ maxNodes: 12_000 });
  });

  // <div data-testid="status"><span>Upload done</span></div> and
  // <button data-testid="save"><span>Save</span></button>
  const web = webTree([
    { testid: "status", text: "Upload done", normalizedFrame: rect(0.1, 0.6, 0.4, 0.05) },
    {
      tag: "span",
      text: "Upload done",
      ownText: "Upload done",
      normalizedFrame: rect(0.1, 0.6, 0.2, 0.03),
    },
    {
      tag: "button",
      type: "submit",
      value: "",
      testid: "save",
      text: "Save",
      normalizedFrame: rect(0.6, 0.6, 0.2, 0.05),
    },
    { tag: "span", text: "Save", ownText: "Save", normalizedFrame: rect(0.65, 0.61, 0.1, 0.03) },
  ]);

  it.each([
    ["a container's text below it", "status", "done", "contains", { success: true }],
    ["a button named by the span in it", "save", "Save", "equals", { success: true }],
    [
      "a container's text below it, quoted in the timeout note",
      "status",
      "Upload failed",
      "contains",
      { success: false, note: expect.stringContaining('its text was "Upload done"') },
    ],
  ])(
    "reads %s, as the flow tree does",
    async (_name, identifier, expectedText, textMatch, outcome) => {
      const { result } = await awaitElement(
        { web },
        { selector: { identifier }, condition: "text", expectedText, textMatch }
      );
      expect(result).toMatchObject(outcome);
    }
  );
});

describe("await-screen-idle on a Mac app", () => {
  it("settles on a still tree from the in-app library", async () => {
    const lib = fakeMacosLibrary();
    const tool = createAwaitScreenIdleTool(macosRegistry(lib.api));
    expect(tool.capability?.macos).toEqual({ app: true });
    const result = await tool.execute(
      {},
      { udid: MACOS_DEVICE_ID, timeoutMs: 2000, pollIntervalMs: 20, minStableMs: 40 }
    );
    expect(result.settled).toBe(true);
    expect(
      lib.calls.every((c) => c.method === "Accessibility.getTree" || c.method === "Web.tree")
    ).toBe(true);
  });
});

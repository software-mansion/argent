/**
 * Gate on the guarantee run-sequence advertises to agents: "One screenshot is
 * captured automatically after the whole sequence (not per step)".
 *
 * Nothing in run-sequence enforces it. The capture is appended once, by the MCP
 * layer, because `run-sequence` is in that layer's AUTO_SCREENSHOT_TOOLS
 * (pinned in argent-mcp's auto-screenshot test). The steps stay silent only
 * because no tool the allow-list admits returns an image or an artifact handle.
 *
 * A step that returned one would be inlined: the sequence result reaches
 * `toMcpContent` whole, and its `materializeArtifacts` walk collects handles
 * from anywhere inside it — `steps[].result` included — appending one image
 * block per handle. That walk recurses into arrays with `Promise.all`, so those
 * frames arrive in completion order rather than step order, leaving the agent
 * unable to tell which is the screen the sequence ended on. Hence the gate sits
 * on the allow-list: such a tool has to be caught before it can be a step.
 */
import { describe, it, expect } from "vitest";
import { ALLOWED_TOOLS } from "../src/tools/run-sequence";
import { createRegistry } from "../src/utils/setup-registry";

// Spelled out rather than counted: adding an entry means answering the question
// this file exists to ask — does that tool put a frame of its own in front of
// the agent?
const EXPECTED_ALLOWED_TOOLS = [
  "await-ui-element",
  "button",
  "gesture-custom",
  "gesture-drag",
  "gesture-pinch",
  "gesture-rotate",
  "gesture-scroll",
  "gesture-swipe",
  "gesture-tap",
  "keyboard",
  "paste",
  "rotate",
  "shake",
  "tv-remote",
];

describe("run-sequence — one observation per sequence", () => {
  it("admits exactly the reviewed set of step tools", () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(EXPECTED_ALLOWED_TOOLS);
  });

  it("names only tools that are actually registered", () => {
    const registry = createRegistry();
    for (const id of ALLOWED_TOOLS) {
      // A name the registry no longer answers to still reads as allowed, and
      // the description still advertises it, but every step naming it dies on
      // ToolNotFoundError and halts the sequence. It also leaves the check
      // below no definition to inspect.
      expect(
        registry.getTool(id),
        `${id} is allowed in run-sequence but not registered`
      ).toBeDefined();
    }
  });

  it("admits no tool that renders as a frame of its own", () => {
    const registry = createRegistry();
    for (const id of ALLOWED_TOOLS) {
      // `outputHint: "image"` declares a result that IS a picture — screenshot
      // alone today. Such a tool also hands back the artifact behind it, so
      // admitting one puts a mid-sequence frame in front of the agent.
      expect(registry.getTool(id)?.outputHint, `${id}.outputHint`).not.toBe("image");
    }
  });
});

/**
 * A physical iPhone's first call outlasts the MCP adapter's 30 s fetch timeout
 * (packages/argent-mcp/src/tool-caller.ts), whose abort replays the POST while
 * the aborted call keeps running, so a mutating tool must be `longRunning`.
 */
import { describe, expect, it } from "vitest";
import { buttonTool } from "../src/tools/button";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureTapTool } from "../src/tools/gesture-tap";

const runnerMutatingTools: { id: string; longRunning?: boolean }[] = [
  gestureTapTool,
  gestureSwipeTool,
  gestureCustomTool,
  buttonTool,
];

describe("tools that send a physical-iPhone runner a mutating command", () => {
  it.each(runnerMutatingTools)(
    "$id is declared longRunning, so the MCP adapter does not replay it while the runner starts",
    (tool) => {
      expect(tool.longRunning).toBe(true);
    }
  );
});

/**
 * On a physical iPhone, the first call of a session waits for the XCUITest
 * runner to build and start, which takes far longer than the MCP adapter's 30 s
 * per-attempt fetch timeout. The adapter then aborts and replays the POST
 * (packages/argent-mcp/src/tool-caller.ts), the tool-server keeps running the
 * aborted call, and each invocation sends its own gesture once the runner is
 * up. `longRunning` turns that timeout off.
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

/**
 * A physical iPhone's first call outlasts the MCP adapter's 30 s fetch timeout
 * (packages/argent-mcp/src/tool-caller.ts), whose abort replays the POST while
 * the aborted call keeps running, so a mutating tool must be `longRunning`.
 */
import { describe, expect, it } from "vitest";
import type { Registry } from "@argent/registry";
import { buttonTool } from "../src/tools/button";
import { createRunFlowTool } from "../src/tools/flows/flow-run";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createRunSequenceTool } from "../src/tools/run-sequence";

const runnerMutatingTools: { id: string; longRunning?: boolean }[] = [
  gestureTapTool,
  gestureSwipeTool,
  gestureCustomTool,
  gesturePinchTool,
  gestureRotateTool,
  buttonTool,
  // Their steps send the same commands.
  createRunSequenceTool({} as Registry),
  createRunFlowTool({} as Registry),
];

describe("tools that send a physical-iPhone runner a mutating command", () => {
  it.each(runnerMutatingTools)(
    "$id is declared longRunning, so the MCP adapter does not replay it while the runner starts",
    (tool) => {
      expect(tool.longRunning).toBe(true);
    }
  );
});

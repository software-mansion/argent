import { describe, expect, it } from "vitest";
import type { Registry } from "@argent/registry";
import { createKeyboardTool } from "../src/tools/keyboard";

describe("keyboard", () => {
  it("is declared longRunning, so the MCP adapter neither aborts nor replays long typing", () => {
    expect(createKeyboardTool({} as Registry).longRunning).toBe(true);
  });
});

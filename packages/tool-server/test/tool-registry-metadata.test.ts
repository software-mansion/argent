import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { ARGENT_TOOL_NAMES } from "../../mcp/src/cli/argent-tool-names";

describe("tool registry metadata", () => {
  it("matches the Codex approval tool list", () => {
    const registry = createRegistry();

    expect([...registry.getSnapshot().tools].sort()).toEqual([...ARGENT_TOOL_NAMES].sort());
  });
});

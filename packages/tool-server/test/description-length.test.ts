import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { definitionsById, EXPECTED_TOOL_COUNT } from "./helpers/catalog";

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false) };
});

/**
 * Claude Code cuts an MCP tool description longer than 4,096 characters and
 * ends it with "… [truncated]", so the rest never reaches the model. Only a
 * tool loaded later through ToolSearch gets 16,384 characters (Claude Code
 * 2.1.316; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` overrides both). With tool
 * search off every tool is sent up front, so the 4,096 limit applies to every
 * tool, not only the `alwaysLoad` ones. Measured with every flag span on: the
 * longest text any user gets.
 */
const CLAUDE_CODE_DESCRIPTION_LIMIT = 4096;

describe("tool descriptions", () => {
  const tools = [...definitionsById(createRegistry())].map(([id, def]) => ({
    id,
    length: renderFlagGated(def.description ?? "", () => true).length,
  }));

  it("are all found", () => {
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it(`fit in Claude Code's ${CLAUDE_CODE_DESCRIPTION_LIMIT}-character limit`, () => {
    expect(tools.filter(({ length }) => length > CLAUDE_CODE_DESCRIPTION_LIMIT)).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { definitionsById } from "./helpers/catalog";

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false) };
});

/**
 * Claude Code cuts the description of a tool it loads up front (`alwaysLoad`)
 * at 4,096 characters and appends "… [truncated]", so the rest never reaches
 * the model. A tool it loads later through ToolSearch arrives whole. Measured
 * with every flag span on: the longest text any user gets.
 */
const CLAUDE_CODE_DESCRIPTION_LIMIT = 4096;

describe("always-loaded tool descriptions", () => {
  const alwaysLoaded = [...definitionsById(createRegistry())]
    .filter(([, def]) => def.alwaysLoad)
    .map(([id, def]) => ({
      id,
      length: renderFlagGated(def.description ?? "", () => true).length,
    }));

  it("are found", () => {
    expect(alwaysLoaded.map(({ id }) => id)).toContain("run-sequence");
  });

  it(`fit in Claude Code's ${CLAUDE_CODE_DESCRIPTION_LIMIT}-character limit`, () => {
    expect(alwaysLoaded.filter(({ length }) => length > CLAUDE_CODE_DESCRIPTION_LIMIT)).toEqual([]);
  });
});

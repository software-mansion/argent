import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createRegistry } from "../../src/utils/setup-registry";
import { definitionsById } from "../helpers/catalog";

/**
 * The Related Skills table is the cross-skill index an agent reads to choose a
 * skill, so a capability named there has to exist before the skill is loaded.
 */
const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-test-ui-flow/SKILL.md");

/** Capability wording the index row may use, lowercased, and the tool behind it. */
const CAPABILITY_TOOLS = new Map([
  ["console logs", "debugger-log-registry"],
  ["js evaluation", "debugger-evaluate"],
  ["component inspection", "debugger-component-tree"],
  ["element inspection", "debugger-inspect-element"],
  ["network logs", "view-network-logs"],
]);

function debuggerRowCapabilities(): string[] {
  const row = readFileSync(SKILL, "utf8")
    .split("\n")
    .find((line) => line.startsWith("| `argent-metro-debugger`"));
  expect(row, `${SKILL} lists no argent-metro-debugger row`).toBeDefined();

  const cells = row!.split("|").map((cell) => cell.trim());
  return cells[2].split(",").map((capability) => capability.trim());
}

describe("argent-metro-debugger's row in the cross-skill index", () => {
  it("advertises only capabilities the row's vocabulary covers", () => {
    const capabilities = debuggerRowCapabilities();

    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(
        CAPABILITY_TOOLS.has(capability.toLowerCase()),
        `"${capability}" is advertised to agents but no argent tool implements it`
      ).toBe(true);
    }
  });

  it("names capabilities that map onto registered tools", () => {
    const tools = definitionsById(createRegistry());

    for (const [capability, toolId] of CAPABILITY_TOOLS) {
      expect(tools.has(toolId), `${toolId} backs "${capability}" but is not registered`).toBe(true);
    }
  });
});

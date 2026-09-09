import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Registry, zodObjectToJsonSchema, type ToolDefinition } from "@argent/registry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { createDebuggerLogRegistryTool } from "../src/tools/debugger/debugger-log-registry";
import { debuggerEvaluateTool } from "../src/tools/debugger/debugger-evaluate";

const SKILL = path.resolve(__dirname, "../../skills/skills/argent-metro-debugger/SKILL.md");

const registry = new Registry();

/** Every tool the skill's "Tool Overview" tables list. */
const OVERVIEW_TOOLS: ToolDefinition<any, any>[] = [
  debuggerConnectTool,
  createDebuggerStatusTool(registry),
  debuggerReloadMetroTool,
  createRestartAppTool(registry),
  debuggerComponentTreeTool,
  debuggerInspectElementTool,
  createDebuggerLogRegistryTool(registry),
  debuggerEvaluateTool,
];

function schemaOf(tool: ToolDefinition<any, any>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const json = zodObjectToJsonSchema(tool.zodSchema!) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return { properties: json.properties ?? {}, required: json.required ?? [] };
}

const overviewSection = (() => {
  const after = readFileSync(SKILL, "utf8").split("## 2. Tool Overview")[1];
  expect(after, "## 2. Tool Overview is missing from the skill").toBeDefined();
  const section = after!.split("\n## 3. ")[0]!;
  expect(section, "## 3. is missing from the skill after ## 2. Tool Overview").not.toBe(after);
  return section;
})();

/** Tool id -> the table row that documents it. */
const rows = new Map(
  [...overviewSection.matchAll(/^\| `([a-z-]+)` +\|.*$/gm)].map((m) => [m[1]!, m[0]!])
);

/** The sentence stating which tools take `port` and `device_id`. */
const targetingClaim = (() => {
  const line = overviewSection.split("\n").find((l) => l.includes("`port` (default 8081)"));
  expect(line, "no sentence in the overview states the targeting parameters").toBeDefined();
  return line!;
})();

describe("argent-metro-debugger tool overview", () => {
  it("documents exactly the tools whose schemas this test reads", () => {
    expect([...rows.keys()].sort()).toEqual(OVERVIEW_TOOLS.map((t) => t.id).sort());
  });

  it("keeps the port/device_id claim off the tools that take neither", () => {
    const outliers = OVERVIEW_TOOLS.filter((tool) => {
      const { properties } = schemaOf(tool);
      return !("port" in properties) || !("device_id" in properties);
    });
    expect(outliers.map((t) => t.id)).toContain("restart-app");

    for (const tool of outliers) {
      expect(
        targetingClaim,
        `${tool.id} takes no port/device_id yet the claim covers it`
      ).toContain(`\`${tool.id}\``);
      for (const param of schemaOf(tool).required) {
        expect(
          rows.get(tool.id),
          `${tool.id}'s row does not name its \`${param}\` parameter`
        ).toContain(`\`${param}\``);
      }
    }
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Registry, zodObjectToJsonSchema, type ToolDefinition } from "@argent/registry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { createDebuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { createDebuggerLogRegistryTool } from "../src/tools/debugger/debugger-log-registry";
import { debuggerEvaluateTool } from "../src/tools/debugger/debugger-evaluate";

const SKILL_DIR = path.resolve(__dirname, "../../skills/skills/argent-metro-debugger");

const registry = new Registry();

const OVERVIEW_TOOLS: ToolDefinition<any, any>[] = [
  debuggerConnectTool,
  createDebuggerStatusTool(registry),
  debuggerReloadMetroTool,
  createRestartAppTool(registry),
  createDebuggerComponentTreeTool(registry),
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
  const after = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8").split(
    "## 2. Tool Overview"
  )[1];
  expect(after, "## 2. Tool Overview is missing from the skill").toBeDefined();
  const section = after!.split("\n## 3. ")[0]!;
  expect(section, "## 3. is missing from the skill after ## 2. Tool Overview").not.toBe(after);
  return section;
})();

/** Tool id -> the table row that documents it. */
const rows = new Map(
  [...overviewSection.matchAll(/^\| `([a-z-]+)` +\|.*$/gm)].map((m) => [m[1]!, m[0]!])
);

const targetingClaim = (() => {
  const line = overviewSection.split("\n").find((l) => l.includes("AND `device_id`"));
  expect(line, "no sentence in the overview states the targeting parameters").toBeDefined();
  return line!;
})();

describe("argent-metro-debugger tool overview", () => {
  it("documents exactly the tools whose schemas this test reads", () => {
    expect([...rows.keys()].sort()).toEqual(OVERVIEW_TOOLS.map((t) => t.id).sort());
  });

  it("exempts from the port/device_id claim exactly the tools missing either", () => {
    const outliers = OVERVIEW_TOOLS.filter((tool) => {
      const { properties } = schemaOf(tool);
      return !("port" in properties) || !("device_id" in properties);
    });
    const exemptions = targetingClaim.match(/ except (.*?) accepts /)?.[1] ?? "";
    const exempted = [...exemptions.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    expect(exempted.sort()).toEqual(outliers.map((t) => t.id).sort());

    for (const tool of outliers) {
      const { properties, required } = schemaOf(tool);
      const [takes] = rows.get(tool.id)!.split(" not ");
      for (const param of required) {
        expect(takes, `${tool.id}'s row does not name its \`${param}\` parameter`).toContain(
          `\`${param}\``
        );
      }
      for (const param of ["port", "device_id"].filter((p) => !(p in properties))) {
        expect(takes, `${tool.id}'s row offers \`${param}\`, which it lacks`).not.toContain(
          `\`${param}\``
        );
      }
    }
  });

  it("names restart-app's required parameters where a recovery spells out its arguments", () => {
    const scenarios = readFileSync(path.join(SKILL_DIR, "references/failure-scenarios.md"), "utf8");
    const recoveries = [...scenarios.matchAll(/`restart-app` with ([^.]*)\./g)].map((m) => m[1]!);
    expect(recoveries).not.toEqual([]);

    const { required } = schemaOf(OVERVIEW_TOOLS.find((t) => t.id === "restart-app")!);
    for (const recovery of recoveries) {
      for (const param of required) expect(recovery).toContain(`\`${param}\``);
    }
  });
});

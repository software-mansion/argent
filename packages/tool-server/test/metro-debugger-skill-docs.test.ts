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
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";

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
  networkLogsTool,
  networkRequestTool,
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
  const after = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8").split("## 2. Tools\n")[1];
  expect(after, "## 2. Tools is missing from the skill").toBeDefined();
  const section = after!.split("\n## 3. ")[0]!;
  expect(section, "## 3. is missing from the skill after ## 2. Tools").not.toBe(after);
  return section;
})();

/** Tool id -> the table row that documents it; one row can name several tools. */
const rows = new Map(
  [...overviewSection.matchAll(/^\| (`[a-z-]+`(?: → `[a-z-]+`)*) +\|.*$/gm)].flatMap((m) =>
    [...m[1]!.matchAll(/`([a-z-]+)`/g)].map((id) => [id[1]!, m[0]!] as const)
  )
);

const targetingClaim = (() => {
  const line = overviewSection
    .split("\n")
    .find((l) => l.includes("`device_id`") && l.includes(" to every call"));
  expect(line, "no sentence in the overview passes `device_id` to every call").toBeDefined();
  return line!;
})();

describe("argent-metro-debugger tool overview", () => {
  it("documents exactly the tools whose schemas this test reads", () => {
    expect([...rows.keys()].sort()).toEqual(OVERVIEW_TOOLS.map((t) => t.id).sort());
  });

  it("exempts from the device_id claim exactly the tools without a device_id parameter", () => {
    const outliers = OVERVIEW_TOOLS.filter((tool) => !("device_id" in schemaOf(tool).properties));
    const exemptions = targetingClaim.match(/ to every call except (.*?), which /)?.[1] ?? "";
    const exempted = [...exemptions.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    expect(exempted.sort(), "tools named in the claim's `except ..., which` clause").toEqual(
      outliers.map((t) => t.id).sort()
    );

    for (const tool of outliers) {
      const { properties, required } = schemaOf(tool);
      const [takes, rejects = ""] = rows.get(tool.id)!.split(" not ");
      for (const param of required) {
        expect(takes, `${tool.id}'s row does not name its \`${param}\` parameter`).toContain(
          `\`${param}\``
        );
      }
      expect(rejects, `${tool.id}'s row does not say it takes no \`device_id\``).toContain(
        "`device_id`"
      );
      for (const param of Object.keys(properties)) {
        expect(rejects, `${tool.id}'s row rejects its own \`${param}\` parameter`).not.toContain(
          `\`${param}\``
        );
      }
    }
  });
});

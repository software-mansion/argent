import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

/**
 * A tool hidden from MCP (`hideFromMcp`) is not in the agent's tool list, so
 * text the agent reads must not send it there: a visible tool's description or
 * parameter text, a skill, or the rule. A hide lands with its replacement and
 * with these references reworded, in the same change.
 */

const SKILLS_ROOT = path.resolve(__dirname, "../../skills");

const definitions = definitionsById(createRegistry());
const all = [...definitions.values()];
const hidden = all.filter((def) => def.hideFromMcp);
const visible = all.filter((def) => !def.hideFromMcp);

/** Ids and former ids of every hidden tool. */
const hiddenNames = hidden.flatMap((def) => [def.id, ...(def.aliases ?? [])]);

/**
 * A hyphenated id is matched as a whole token. A one-word id (`fill`) is also an
 * English word, so only its code span counts.
 */
function mentionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.includes("-")
    ? new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`)
    : new RegExp(`\`${escaped}\``);
}

/**
 * Error messages quoted verbatim, which use a hidden id as a plain word. Only
 * the quoted phrase is exempt, never the line around it.
 */
const QUOTED_MESSAGES = [
  // The e2e runner's refusal of a selector step on HarmonyOS (harmonyos.md).
  "ui-tree matching is not supported",
];

function hiddenMentions(text: string): string[] {
  const scanned = QUOTED_MESSAGES.reduce((acc, quote) => acc.split(quote).join(""), text);
  return hiddenNames.filter((name) => mentionPattern(name).test(scanned));
}

/** Every description string in a JSON schema, nested properties included. */
function schemaDescriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) schemaDescriptions(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") out.push(value);
      else schemaDescriptions(value, out);
    }
  }
  return out;
}

function agentFacingText(def: ToolDefinition<any, any>): string {
  return [def.description ?? "", ...schemaDescriptions(advertisedSchema(def))].join("\n");
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

describe("text the agent reads names no tool hidden from MCP", () => {
  it("has hidden tools and skill files to check", () => {
    expect(hiddenNames).toEqual(
      expect.arrayContaining(["react-profiler-component-source", "react-profiler-cpu-summary"])
    );
    expect(markdownFiles(SKILLS_ROOT).length).toBeGreaterThan(10);
    expect(hiddenMentions("call `react-profiler-component-source` next")).toEqual([
      "react-profiler-component-source",
    ]);
    expect(hiddenMentions("fill in the form")).toEqual([]);
  });

  it.each(visible.map((def) => [def.id, def] as const))(
    "%s: description and parameters",
    (_id, def) => {
      expect(hiddenMentions(agentFacingText(def))).toEqual([]);
    }
  );

  it.each(markdownFiles(SKILLS_ROOT).map((file) => [path.relative(SKILLS_ROOT, file), file]))(
    "%s",
    (_name, file) => {
      expect(hiddenMentions(readFileSync(file, "utf8"))).toEqual([]);
    }
  );
});

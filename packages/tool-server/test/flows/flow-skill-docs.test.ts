import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseFlow } from "../../src/tools/flows/flow-utils";

/**
 * The create-flow skill is the agent-facing reference for selector scopes, so
 * a snippet that no longer parses is a live defect: an agent copies it and the
 * flow fails at parse. Guards the examples against parser drift.
 */
const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-create-flow/SKILL.md");

function scopesSection(): string {
  const md = readFileSync(SKILL, "utf8");
  const after = md.split("#### Scopes")[1];
  expect(after, "the scopes section is missing from SKILL.md").toBeDefined();
  return after!.split("\nSelectors resolve against")[0]!;
}

// `…` marks an illustrative fragment (`within: <sel>`, and the deliberately
// REJECTED spelling the `any` paragraph contrasts against) — not runnable YAML.
const runnable = (snippet: string): boolean => !snippet.includes("…") && !snippet.includes("<sel>");

describe("create-flow SKILL.md scope snippets", () => {
  it("every step snippet in the scopes section parses", () => {
    const snippets = [...scopesSection().matchAll(/`((?:tap|assert|await|type|scroll-to):[^`]*)`/g)]
      .map((m) => m[1]!)
      .filter(runnable);
    expect(snippets.length).toBeGreaterThan(8);
    for (const snippet of snippets) {
      expect(() => parseFlow(`steps:\n  - ${snippet}\n`), snippet).not.toThrow();
    }
  });

  it("every bare selector map in the scopes section parses in a tap slot", () => {
    const maps = [...scopesSection().matchAll(/`(\{ (?:role|text|id|any)[^`]*\})`/g)]
      .map((m) => m[1]!)
      .filter(runnable);
    expect(maps.length).toBeGreaterThan(3);
    for (const map of maps) {
      expect(() => parseFlow(`steps:\n  - tap: ${map}\n`), map).not.toThrow();
    }
  });

  it("the paragraph's rejected `any` spelling really is rejected", () => {
    // The docs tell agents to write `{ role: Switch, next: … }` and NOT
    // `{ any: true, role: Switch, next: … }`. If the parser ever started
    // accepting the second, the advice would be noise.
    expect(scopesSection()).toContain("may **not** sit beside");
    expect(() =>
      parseFlow("steps:\n  - tap: { any: true, role: Switch, next: { text: Wi-Fi } }\n")
    ).toThrow(/already matches every element/);
    expect(() =>
      parseFlow("steps:\n  - tap: { role: Switch, next: { text: Wi-Fi } }\n")
    ).not.toThrow();
  });
});

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

function repeatDocs(): string {
  const md = readFileSync(SKILL, "utf8");
  // The directive table's row, plus the `repeat:` bullet block in the file
  // format section — the two places the doc spells a repeat bound.
  const row = md.split("\n").find((line) => line.startsWith("| `repeat`"));
  expect(row, "the repeat row is missing from the directive table in SKILL.md").toBeDefined();
  const section = md.split("- **`repeat:` blocks**")[1];
  expect(section, "the repeat: blocks section is missing from SKILL.md").toBeDefined();
  return `${row!}\n${section!.split("\nThe polished result")[0]!}`;
}

// `…` marks an illustrative fragment (`within: <sel>`, and the deliberately
// REJECTED spelling the `any` paragraph contrasts against) — not runnable YAML.
// `{ times }` is the same thing for a bound: the heading contrasting
// `repeat: { times }` with `tap: { times }` names the KEY, not a count.
const runnable = (snippet: string): boolean =>
  !snippet.includes("…") && !snippet.includes("<sel>") && !snippet.includes("{ times }");

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

describe("create-flow SKILL.md repeat snippets", () => {
  it("every repeat: bound the doc spells parses, in both bounds", () => {
    // The doc writes the bound and its sibling `steps: [...]` as two separate
    // snippets, so a bound alone is not a runnable step — supply a body, which
    // is what an agent copying the pair ends up with.
    const bounds = [...repeatDocs().matchAll(/`-? ?(repeat: [^`]*)`/g)]
      .map((m) => m[1]!)
      .filter(runnable);
    // Both bounds, from both places: the count and the drain.
    expect(new Set(bounds).size).toBeGreaterThanOrEqual(2);
    expect(bounds.some((b) => b.includes("until"))).toBe(true);
    for (const bound of bounds) {
      expect(
        () => parseFlow(`steps:\n  - ${bound}\n    steps: [{ tap: A }]\n`),
        bound
      ).not.toThrow();
    }
  });

  it("the section's two stated parse errors really are parse errors", () => {
    // Both are claims the doc makes about the parser, in the same class as the
    // rejected `any` spelling above: if either stopped holding, the section
    // would be teaching a restriction that isn't one.
    const docs = repeatDocs();
    expect(docs).toContain("**minus `platform`**");
    expect(() =>
      parseFlow("steps:\n  - repeat: { until: { platform: ios } }\n    steps: [{ tap: A }]\n")
    ).toThrow(/repeat\.until takes no platform/i);

    expect(docs).toContain("is a **parse error**");
    expect(() => parseFlow("steps:\n  - repeat: 2\n    steps: [{ snapshot: home }]\n")).toThrow(
      /cannot run inside a repeat block/i
    );
  });
});

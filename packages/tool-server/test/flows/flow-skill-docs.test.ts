import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  IDLE_DEFAULT_MIN_STABLE_MS,
  IDLE_DEFAULT_TIMEOUT_MS,
  IDLE_MIN_STILL_INTERVALS,
  IDLE_POLL_MS,
  IDLE_SETTLE_OVERHEAD_MS,
  parseFlow,
} from "../../src/tools/flows/flow-utils";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

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

  // The two agent-facing descriptions of `idle` have to agree with what it
  // does. The commit that turned its timeout from a failure into a warning
  // updated the skill, the comments and the tests, and left the tool
  // description — the surface an authoring agent actually reads — saying the
  // opposite, with "so it is safe to persist" hung off the claim that was now
  // backwards.
  it("the flow-execute description and the skill agree that idle warns rather than fails", () => {
    const description = createRunFlowTool({} as unknown as Registry).description;
    expect(description).toContain("idle: true");
    expect(description).toMatch(/never\s+fails a run/);
    expect(description).not.toMatch(/FAILS on timeout/i);

    const skill = readFileSync(SKILL, "utf8");
    expect(skill).toContain("It **never fails a run.**");
    // The one outcome that does stop a run is the window, never the app.
    expect(skill).toMatch(/Only a tree source that cannot be read stops the run/);
    // Both surfaces have to carry that caveat: the description is what an
    // authoring agent reads, and "never fails a run" on its own is not true
    // of a tree nobody could read.
    expect(description).toMatch(/unreadable|cannot be read|could not be read/);
  });

  // The claims above are prose until something ties them to the runner. These
  // pin the numbers the skill quotes to the constants the parser enforces, so
  // a default that moves takes the sentence describing it with it.
  it("the skill's idle defaults and settle cost are the ones the parser enforces", () => {
    const skill = readFileSync(SKILL, "utf8");
    expect(skill).toContain(`default ${IDLE_DEFAULT_MIN_STABLE_MS}`);
    expect(skill).toContain(`default ${IDLE_DEFAULT_TIMEOUT_MS}`);
    expect(skill).toContain(`${IDLE_SETTLE_OVERHEAD_MS}ms a settle costs`);
    expect(skill).toContain(`${IDLE_POLL_MS}ms polls`);
    // The gloss has to add up to the cost it explains: the polls the intervals
    // span, plus the round-start floor. Without the second term it described
    // 400ms while demanding 600.
    expect(IDLE_SETTLE_OVERHEAD_MS).toBe((IDLE_MIN_STILL_INTERVALS + 1) * IDLE_POLL_MS);
    expect(skill).toContain(`plus the ${IDLE_POLL_MS}ms of budget the closing round`);
  });

  it("the smallest timeout the skill's arithmetic allows is the one the parser accepts", () => {
    // The skill tells an author the wait has to contain the hold plus the
    // settle. Take it at its word and check the boundary both ways — a parser
    // that demanded a millisecond more would make the documented sum a lie.
    const smallest = IDLE_DEFAULT_MIN_STABLE_MS + IDLE_SETTLE_OVERHEAD_MS;
    expect(() =>
      parseFlow(`steps:\n  - await: { idle: true, timeout: ${smallest} }\n`)
    ).not.toThrow();
    expect(() =>
      parseFlow(`steps:\n  - await: { idle: true, timeout: ${smallest - 1} }\n`)
    ).toThrow(new RegExp(`at least ${smallest}ms`));
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

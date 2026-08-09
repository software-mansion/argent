import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  IDLE_DEFAULT_STABLE_FOR_MS,
  IDLE_DEFAULT_TIMEOUT_MS,
  IDLE_MIN_STILL_INTERVALS,
  IDLE_POLL_MS,
  IDLE_SETTLE_SPAN_MS,
  idleMinimumTimeoutMs,
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
    expect(skill).toContain(`default ${IDLE_DEFAULT_STABLE_FOR_MS}`);
    expect(skill).toContain(`default ${IDLE_DEFAULT_TIMEOUT_MS}`);
    expect(skill).toContain(`${IDLE_SETTLE_SPAN_MS}ms a settle spans`);
    expect(skill).toContain(`${IDLE_POLL_MS}ms polls`);
    // The gloss has to describe the span it names: the polls the intervals are
    // measured over. The round-start floor is quoted separately because it is
    // the one term that IS added.
    expect(IDLE_SETTLE_SPAN_MS).toBe(IDLE_MIN_STILL_INTERVALS * IDLE_POLL_MS);
    expect(skill).toContain(`plus the ${IDLE_POLL_MS}ms of budget the closing round`);
    // And the worked numbers it hands the author have to be the parser's.
    expect(skill).toContain(
      `the default ${IDLE_DEFAULT_STABLE_FOR_MS}ms hold needs ` +
        `${idleMinimumTimeoutMs(IDLE_DEFAULT_STABLE_FOR_MS)}ms and an 800ms hold needs ` +
        `${idleMinimumTimeoutMs(800)}ms`
    );
  });

  it("the smallest timeout the skill's arithmetic allows is the one the parser accepts", () => {
    // The skill tells an author the wait has to contain the LONGER of the hold
    // and the settle's span, plus the closing round's budget. Take it at its
    // word on both sides of the max — a hold under the span and one over it —
    // and check each boundary both ways, since a parser that demanded a
    // millisecond more would make the documented arithmetic a lie.
    for (const stableFor of [IDLE_DEFAULT_STABLE_FOR_MS, 800]) {
      const smallest = Math.max(IDLE_SETTLE_SPAN_MS, stableFor) + IDLE_POLL_MS;
      expect(idleMinimumTimeoutMs(stableFor)).toBe(smallest);
      const step = (t: number): string =>
        `steps:\n  - await: { idle: true, stableFor: ${stableFor}, timeout: ${t} }\n`;
      expect(() => parseFlow(step(smallest)), `${stableFor}`).not.toThrow();
      expect(() => parseFlow(step(smallest - 1)), `${stableFor}`).toThrow(
        new RegExp(`at least ${smallest}ms`)
      );
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

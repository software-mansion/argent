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
 * Keep the core skill's scope routing concise while guarding the linked
 * reference examples against parser drift.
 */
const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-create-flow/SKILL.md");
const FLOW_YAML = path.resolve(
  __dirname,
  "../../../skills/skills/argent-create-flow/references/flow-yaml.md"
);
const FIELD_VALUES = path.resolve(
  __dirname,
  "../../../skills/skills/argent-create-flow/references/asserting-field-values.md"
);
/**
 * The three surfaces that quote the number of `idle` warnings instead of
 * listing them. They cite the reference rather than restating it, so a warning
 * added to the list leaves all three saying the wrong count — which is exactly
 * how "five different warnings" survived a sixth being added.
 */
const WARNING_COUNT_CITATIONS = [
  path.resolve(__dirname, "../../../skills/skills/argent-create-flow/references/live-authoring.md"),
  path.resolve(
    __dirname,
    "../../../skills/skills/argent-create-flow/references/reliability-and-recovery.md"
  ),
  path.resolve(__dirname, "../../../skills/skills/argent-qa-flows/SKILL.md"),
];

/**
 * The text between two markers. BOTH are asserted: `split` on an absent
 * separator returns a single-element array, so an unchecked `end` would widen
 * the section silently to EOF — and the callers below then count snippets from
 * the rest of the file instead of failing on the renamed heading.
 */
function between(file: string, start: string, end: string): string {
  const after = readFileSync(file, "utf8").split(start)[1];
  expect(after, `${start} is missing from ${file}`).toBeDefined();
  const section = after!.split(end)[0]!;
  expect(section, `${end} is missing from ${file} after ${start}`).not.toBe(after);
  return section;
}

describe("create-flow selector-scope docs", () => {
  it("keeps the core skill concise and routes every relation", () => {
    const section = between(SKILL, "### Flow-only selector scopes", "\n## Workflow");
    expect(section).toContain("`within`");
    expect(section).toContain("`after`");
    expect(section).toContain("`next`");
    expect(section).toContain("references/flow-yaml.md#relational-scopes");
  });

  it("keeps the reference examples parsable", () => {
    const section = between(FLOW_YAML, "### Relational scopes", "\n## Directives");
    const snippets = [
      ...section.matchAll(/^\s*- ((?:tap|assert|await|type|scroll-to):.+?)(?:\s+#.*)?$/gm),
    ].map((m) => m[1]!);
    expect(snippets).toHaveLength(3);
    for (const snippet of snippets) {
      expect(() => parseFlow(`steps:\n  - ${snippet}\n`), snippet).not.toThrow();
    }
  });

  it("keeps every inline `type:` example parsable, `clear` ones included", () => {
    // The guard above slices one section, and every `clear` example sits after
    // `## Directives` — so the directive's own examples, the ones an author
    // copies, were unguarded. These are inline code spans in prose rather than
    // list items, so they are matched as spans.
    const reference = readFileSync(FLOW_YAML, "utf8");
    const snippets = [...reference.matchAll(/`(type: \{[^`]*\})`/g)].map((m) => m[1]!);
    // A floor, not a count: the point is that new examples are covered too.
    expect(snippets.length).toBeGreaterThanOrEqual(2);
    expect(snippets.filter((s) => s.includes("clear")).length).toBeGreaterThanOrEqual(2);
    for (const snippet of snippets) {
      expect(() => parseFlow(`steps:\n  - ${snippet}\n`), snippet).not.toThrow();
    }
  });
});

// The `idle` account moved out of SKILL.md into the flow-yaml reference, so
// these read it there. They are otherwise the guards that came with the
// warn-instead-of-fail change: the two agent-facing descriptions of `idle`
// have to agree with what it does, and the numbers the prose quotes have to be
// the ones the parser enforces.
describe("create-flow idle docs", () => {
  it("the flow-execute description and the reference agree that idle warns rather than fails", () => {
    const description = createRunFlowTool({} as unknown as Registry).description;
    expect(description).toContain("idle: true");
    expect(description).toMatch(/never\s+fails a run/);
    expect(description).not.toMatch(/FAILS on timeout/i);

    const reference = readFileSync(FLOW_YAML, "utf8");
    expect(reference).toContain("It **never fails a run.**");
    // The one outcome that does stop a run is the window, never the app - and
    // it is scoped to the step that could not read, since the same outage
    // leaves a selector-less gesture passing with a warning of its own.
    expect(reference).toMatch(/Only a tree source this step could not read stops the run/);
    expect(reference).toMatch(/stops no \[selector-less gesture\]/);
    // Both surfaces have to carry that caveat: the description is what an
    // authoring agent reads, and "never fails a run" on its own is not true
    // of a tree nobody could read.
    expect(description).toMatch(/unreadable|cannot be read|could not be read/);
  });

  it("the reference's idle defaults and settle span are the ones the parser enforces", () => {
    const reference = readFileSync(FLOW_YAML, "utf8");
    expect(reference).toContain(`default ${IDLE_DEFAULT_STABLE_FOR_MS}`);
    expect(reference).toContain(`default ${IDLE_DEFAULT_TIMEOUT_MS}`);
    expect(reference).toContain(`${IDLE_SETTLE_SPAN_MS}ms a settle spans`);
    expect(reference).toContain(`${IDLE_POLL_MS}ms polls`);
    // The gloss has to describe the span it names: the polls the intervals are
    // measured over. The round-start floor is quoted separately because it is
    // the one term that IS added.
    expect(IDLE_SETTLE_SPAN_MS).toBe(IDLE_MIN_STILL_INTERVALS * IDLE_POLL_MS);
    expect(reference).toContain(`plus the ${IDLE_POLL_MS}ms of budget the closing round`);
    // And the worked numbers it hands the author have to be the parser's.
    expect(reference).toContain(
      `the default ${IDLE_DEFAULT_STABLE_FOR_MS}ms hold needs ` +
        `${idleMinimumTimeoutMs(IDLE_DEFAULT_STABLE_FOR_MS)}ms and an 800ms hold needs ` +
        `${idleMinimumTimeoutMs(800)}ms`
    );
  });

  it("every doc that quotes the number of idle warnings quotes the number the reference lists", () => {
    const warnings = between(FLOW_YAML, "It **never fails a run.**", "\nOnly a tree source");
    const listed = [...warnings.matchAll(/^- \*\*/gm)].length;
    // Guard the reader itself: a section that stopped matching would count 0
    // and then agree with nothing, which is not the failure we want reported.
    expect(listed).toBeGreaterThan(1);
    const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][
      listed
    ];
    expect(spelled, `no spelling for ${listed} warnings`).toBeDefined();
    for (const file of WARNING_COUNT_CITATIONS) {
      // Anchored on the linked citation, not on any "… warnings" phrase: these
      // files also say things like "Read this file for selector warnings".
      const quoted = readFileSync(file, "utf8").match(
        /\[(?:which of the )?(\w+) (?:different )?warnings\]\(/
      );
      expect(quoted, `${file} no longer cites the idle warning count`).not.toBeNull();
      expect(quoted![1], file).toBe(spelled);
    }
  });

  it("the smallest timeout the reference's arithmetic allows is the one the parser accepts", () => {
    // The reference tells an author the wait has to contain the LONGER of the
    // hold and the settle's span, plus the closing round's budget. Take it at
    // its word on both sides of the max — a hold under the span and one over
    // it — and check each boundary both ways, since a parser that demanded a
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
});

// The clear-only guidance rests on three parse-time facts, and an author who
// tries the rejected forms first only learns which is which by running a flow.
// The reference is unguarded otherwise: it is the one create-flow reference no
// test reads.
describe("create-flow asserting-field-values docs", () => {
  const assertStep = (body: string): string => `steps:\n  - assert: { text: ${body} }\n`;

  it("keeps the clear-only section's parser claims true", () => {
    const section = between(FIELD_VALUES, "## A clear-only step", "\nAssert the OLD value");
    expect(section).toContain('`equals: ""` and `contains: ""` are rejected');
    expect(section).toContain("`matches: '^$'`");
    // Rejected at parse time, exactly as the section says…
    expect(() => parseFlow(assertStep('{ in: { id: f }, equals: "" }'))).toThrow();
    expect(() => parseFlow(assertStep('{ in: { id: f }, contains: "" }'))).toThrow();
    // …and the regex form parses, which is why the section has to warn that it
    // parses and still never matches rather than simply calling it invalid.
    expect(() => parseFlow(assertStep('{ in: { id: f }, matches: "^$" }'))).not.toThrow();
  });

  it("keeps the alternative it prescribes parsable", () => {
    // What the section sends the author to instead, both forms.
    expect(() => parseFlow(`steps:\n  - assert: { hidden: "the old value" }\n`)).not.toThrow();
    expect(() =>
      parseFlow(assertStep('{ in: { id: f }, contains: "the old value" }'))
    ).not.toThrow();
    expect(readFileSync(FIELD_VALUES, "utf8")).toContain('- assert: { hidden: "the old value" }');
  });
});

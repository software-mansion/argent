import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { zodObjectToJsonSchema, type Registry } from "@argent/registry";
import {
  IDLE_DEFAULT_STABLE_FOR_MS,
  IDLE_DEFAULT_TIMEOUT_MS,
  IDLE_MIN_STILL_INTERVALS,
  IDLE_POLL_MS,
  IDLE_SETTLE_SPAN_MS,
  idleMinimumTimeoutMs,
  parseFlow,
  STEP_DIRECTIVE_KEYS,
} from "../../src/tools/flows/flow-utils";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool, directiveCommandHint } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";

/**
 * Keep the core skill's scope routing concise while guarding the linked
 * reference examples against parser drift.
 */
const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-create-flow/SKILL.md");
const FLOW_YAML = path.resolve(
  __dirname,
  "../../../skills/skills/argent-create-flow/references/flow-yaml.md"
);
const LIVE_AUTHORING = path.resolve(
  __dirname,
  "../../../skills/skills/argent-create-flow/references/live-authoring.md"
);
/**
 * The three surfaces that quote the number of `idle` warnings instead of
 * listing them. They cite the reference rather than restating it, so a warning
 * added to the list leaves all three saying the wrong count — which is exactly
 * how "five different warnings" survived a sixth being added.
 */
const WARNING_COUNT_CITATIONS = [
  LIVE_AUTHORING,
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
});

describe("nested wait docs", () => {
  it("flow-start-recording and live-authoring agree on a wait inside a run-sequence", () => {
    const { description } = flowStartRecordingTool;
    expect(description, "flow-start-recording no longer declares a description").toBeDefined();

    // Both surfaces answer the same question, and the description is the one an
    // agent reaches first. An unmet nested wait is refused, so there is no
    // recorded batch left to inspect for it.
    expect(description!).toMatch(/refuses the whole call/);
    expect(description!).toMatch(/`stepCount` does not move/);
    expect(description!).not.toMatch(/for those, read `toolResult`/);

    const reference = readFileSync(LIVE_AUTHORING, "utf8");
    expect(reference).toContain("the recorder refuses the whole call");
    expect(reference).toContain("`stepCount` does not move");
    // The remedy both give, and the reason the met case needs it too.
    expect(description!).toMatch(/Record each\s+wait as its own flow-add-step call/);
    expect(reference).toContain("Record each wait as its own `flow-add-step` call");
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

describe("create-flow directive-answer docs", () => {
  const answered = STEP_DIRECTIVE_KEYS.filter((key) => directiveCommandHint(key) !== undefined);
  const withoutRecordingTool = answered.filter((key) =>
    directiveCommandHint(key)!.includes("records one")
  );
  const withRecordingTool = answered.filter((key) => !withoutRecordingTool.includes(key));

  function sentenceWith(paragraph: string, marker: string): string {
    const hit = paragraph.split(". ").find((s) => s.includes(marker));
    expect(hit, `no sentence mentions "${marker}"`).toBeDefined();
    return hit!;
  }

  function commandParamDescription(): string {
    const schema = zodObjectToJsonSchema(createFlowAddStepTool({} as Registry).zodSchema!) as {
      properties: Record<string, { description?: string }>;
    };
    const described = schema.properties.command?.description;
    expect(described, "`command` no longer describes itself").toBeDefined();
    return described!;
  }

  it("names every directive it answers, so a new one cannot go unmentioned", () => {
    expect(answered.length).toBeGreaterThan(0);
    const clause = sentenceWith(commandParamDescription(), "is answered with guidance");
    for (const key of answered) expect(clause, key).toContain(`"${key}"`);
  });

  it("names each directive that has no recording tool, on both surfaces", () => {
    expect(withoutRecordingTool.length).toBeGreaterThan(0);
    const { description } = createFlowAddStepTool({} as Registry);
    expect(description, "flow-add-step no longer declares a description").toBeDefined();
    for (const key of withoutRecordingTool) {
      expect(sentenceWith(description!, "have no recording tool"), key).toContain(`\`${key}\``);
      expect(commandParamDescription(), key).toContain(`"${key}"`);
    }
    for (const key of withRecordingTool) {
      expect(sentenceWith(description!, "have no recording tool"), key).not.toContain(`\`${key}\``);
    }
  });
});

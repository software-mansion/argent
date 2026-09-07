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
const SPELLED = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
/**
 * How each insertion in {@link LIVE_AUTHORING}'s list is spelled in rule 5 of
 * the core skill, which enumerates them rather than counting them. Kept in
 * step with that list by the length assertion in the guard below, so a fourth
 * bullet cannot be added while rule 5 still says "the only" three.
 */
const RULE_5_INSERTIONS = ["`snapshot:`", "`await: { idle: true }`", "Chromium"];
const INSERTION_COUNT_CITATIONS = [
  path.resolve(__dirname, "../../../skills/skills/argent-qa-flows/SKILL.md"),
];

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

  it("every doc that quotes the number of permitted insertions quotes the number listed", () => {
    const list = between(
      LIVE_AUTHORING,
      "Only these unrecorded insertions are allowed, at states observed live:",
      "\nKeep raw forms only"
    );
    const listed = [...list.matchAll(/^- /gm)].length;
    expect(listed).toBeGreaterThan(1);
    const spelled = SPELLED[listed];
    expect(spelled, `no spelling for ${listed} insertions`).toBeDefined();
    for (const file of INSERTION_COUNT_CITATIONS) {
      const quotes = [
        ...readFileSync(file, "utf8").matchAll(/(\w+) (?:documented|permitted) polish insertions/g),
      ];
      expect(quotes.length, `${file} no longer cites the insertion count`).toBeGreaterThan(0);
      for (const quote of quotes) expect(quote[1], file).toBe(spelled);
    }
    // Rule 5 cites no number — it ENUMERATES the insertions inline — so the
    // spelled count above cannot police it. Hold it to the same list instead,
    // and read only that sentence: `await: { idle: true }` is also in rule 4,
    // so a file-wide search would pass with rule 5's copy of it deleted.
    const rule5 = between(SKILL, "The only unrecorded insertions are", "\n");
    expect(
      RULE_5_INSERTIONS,
      `rule 5 names ${RULE_5_INSERTIONS.length} insertions, the reference lists ${listed}`
    ).toHaveLength(listed);
    for (const token of RULE_5_INSERTIONS) {
      expect(rule5, `rule 5 no longer names ${token} as an insertion`).toContain(token);
    }
  });

  it("every doc that quotes the number of idle warnings quotes the number the reference lists", () => {
    const warnings = between(FLOW_YAML, "It **never fails a run.**", "\nOnly a tree source");
    const listed = [...warnings.matchAll(/^- \*\*/gm)].length;
    // Guard the reader itself: a section that stopped matching would count 0
    // and then agree with nothing, which is not the failure we want reported.
    expect(listed).toBeGreaterThan(1);
    const spelled = SPELLED[listed];
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

  function commandParamDescription(): string {
    const schema = zodObjectToJsonSchema(createFlowAddStepTool({} as Registry).zodSchema!) as {
      properties: Record<string, { description?: string }>;
    };
    const described = schema.properties.command?.description;
    expect(described, "`command` no longer describes itself").toBeDefined();
    return described!;
  }

  it("keeps directive guidance out of the command schema", () => {
    const description = commandParamDescription();
    expect(description).toContain("MCP tool to execute and record");
    expect(description).toContain("Do not pass a flow directive or a recording tool");
    expect(description).toContain("Call flow-add-script directly");
    expect(description.split(/\s+/).length).toBeLessThan(40);
  });

  it("returns guidance for each answered directive", () => {
    expect(answered.length).toBeGreaterThan(0);
    for (const key of answered) {
      expect(directiveCommandHint(key), key).toContain(`"${key}"`);
    }
    expect(directiveCommandHint("script")).toBe(
      '"script" is a flow directive. Call `flow-add-script` directly.'
    );
  });
});

/**
 * The `script` account in the flow-execute description is the only agent-facing
 * statement of what the step needs and where its path points, so the two claims
 * an author acts on are pinned here rather than left to prose review.
 */
describe("create-flow script docs", () => {
  const description = (): string => {
    const { description: text } = createRunFlowTool({} as unknown as Registry);
    expect(text, "flow-execute no longer declares a description").toBeDefined();
    return text!;
  };

  it("names every step that still resolves a device beside a deviceless script", () => {
    // `run` and `when` are the two whose own body can be nothing but scripts
    // and that resolve one anyway — `run` because the fragment is read at run
    // time, `when` because the guard reads the device itself. A platform-gated
    // seed is the natural next thing to write after this sentence, and on a
    // host with no device of that platform the whole run is refused.
    for (const kind of ["run", "when"]) {
      expect(description(), kind).toMatch(
        new RegExp(`a script-only flow runs with nothing booted[^.]*\`${kind}\``)
      );
    }
  });

  it("shows a script path that reaches the directory scripts really live in", () => {
    // A path relative to the flow FILE, so a saved flow anchors in
    // `.argent/flows/`. `scripts/seed.mjs` there names
    // `.argent/flows/scripts/seed.mjs`, which is two directories from where the
    // reference page and the skills put a script.
    expect(description()).toContain("script: { path: ../../scripts/seed.mjs");
  });

  it("lists a script path among what a flow_path run re-anchors", () => {
    // `project_root` still names the script's working directory either way; it
    // is the RESOLUTION that moves to the YAML, and a `script:` path is the
    // third thing that moves with it.
    const schema = zodObjectToJsonSchema(
      createRunFlowTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, { description?: string }> };
    const projectRoot = schema.properties.project_root?.description;
    expect(projectRoot, "`project_root` no longer describes itself").toBeDefined();
    expect(projectRoot!).toMatch(/with flow_path[^.]*script:/);
  });

  it("lets the chromium hoist follow every step a leading launch can sit behind", () => {
    // The same set `precedesLeadingLaunch` admits. A flow that seeds a backend
    // before it launches is exactly the shape this PR added, and it boots its
    // own instance like any other leading launch.
    for (const kind of ["run:", "echo:", "script:"]) {
      expect(description(), kind).toMatch(
        new RegExp(`following a leading[^.]*\`${kind.replace(":", ":")}\``)
      );
    }
  });
});

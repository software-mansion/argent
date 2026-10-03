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
const RULE_5_INSERTIONS = ["`snapshot:`", "`await: { idle: true }`", "Chromium"];
const INSERTION_COUNT_CITATIONS = [
  path.resolve(__dirname, "../../../skills/skills/argent-qa-flows/SKILL.md"),
];

const WARNING_COUNT_CITATIONS = [
  LIVE_AUTHORING,
  path.resolve(
    __dirname,
    "../../../skills/skills/argent-create-flow/references/reliability-and-recovery.md"
  ),
  path.resolve(__dirname, "../../../skills/skills/argent-qa-flows/SKILL.md"),
];

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

describe("bash script failure docs", () => {
  const REFERENCE = path.resolve(__dirname, "../../../docs/docs/reference/flow-yaml.mdx");

  it.each([REFERENCE, FLOW_YAML, LIVE_AUTHORING, SKILL])("names no reason file in %s", (file) => {
    expect(readFileSync(file, "utf8")).not.toContain("ARGENT_REASON");
  });

  it("teaches the stderr failure reason in the Bash documentation", () => {
    const section = between(REFERENCE, "### Bash scripts", "\n## The `argent flow` command");
    expect(section).toMatch(/last non-blank[^.]*stderr/);
    expect(section).toMatch(/echo "[^"]+" >&2(?:;|\n)\s*exit 1/);
    expect(section).toMatch(/reason[^.]*stdout|stdout[^.]*reason/);
  });
});

describe("create-flow idle docs", () => {
  it("the reference says idle warns rather than fails", () => {
    const reference = readFileSync(FLOW_YAML, "utf8");
    expect(reference).toContain("It **never fails a run.**");
    expect(reference).toMatch(/Only a tree source this step could not read stops the run/);
    expect(reference).toMatch(/stops no \[selector-less gesture\]/);
  });

  it("the reference's idle defaults and settle span are the ones the parser enforces", () => {
    const reference = readFileSync(FLOW_YAML, "utf8");
    expect(reference).toContain(`default ${IDLE_DEFAULT_STABLE_FOR_MS}`);
    expect(reference).toContain(`default ${IDLE_DEFAULT_TIMEOUT_MS}`);
    expect(reference).toContain(`${IDLE_SETTLE_SPAN_MS}ms a settle spans`);
    expect(reference).toContain(`${IDLE_POLL_MS}ms polls`);
    expect(IDLE_SETTLE_SPAN_MS).toBe(IDLE_MIN_STILL_INTERVALS * IDLE_POLL_MS);
    expect(reference).toContain(`plus the ${IDLE_POLL_MS}ms of budget the closing round`);
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
    expect(listed).toBeGreaterThan(1);
    const spelled = SPELLED[listed];
    expect(spelled, `no spelling for ${listed} warnings`).toBeDefined();
    for (const file of WARNING_COUNT_CITATIONS) {
      const quoted = readFileSync(file, "utf8").match(
        /\[(?:which of the )?(\w+) (?:different )?warnings\]\(/
      );
      expect(quoted, `${file} no longer cites the idle warning count`).not.toBeNull();
      expect(quoted![1], file).toBe(spelled);
    }
  });

  it("the smallest timeout the reference's arithmetic allows is the one the parser accepts", () => {
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

describe("create-flow script docs", () => {
  it("lists a script path among what a flow_path run re-anchors", () => {
    const schema = zodObjectToJsonSchema(
      createRunFlowTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, { description?: string }> };
    const projectRoot = schema.properties.project_root?.description;
    expect(projectRoot, "`project_root` no longer describes itself").toBeDefined();
    expect(projectRoot!).toMatch(/with flow_path[^.]*script:/);
  });
});

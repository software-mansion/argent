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
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { reservedScriptEnvNamesForMessage } from "@argent/configuration-core";

/** One tool's `env` parameter description, as the JSON schema publishes it. */
function envParameterDescription(tool: { zodSchema?: unknown }): string {
  const schema = zodObjectToJsonSchema(
    (tool as { zodSchema: Parameters<typeof zodObjectToJsonSchema>[0] }).zodSchema
  ) as { properties: Record<string, { description?: string }> };
  const described = schema.properties.env?.description;
  expect(described).toBeDefined();
  return described!;
}

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
  it("keeps the reference's env example parsable and its reserved list complete", () => {
    const section = between(FLOW_YAML, "## Environment values", "\n## Snapshots");
    // The example, exactly as an author would copy it.
    const example = section.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(example).toBeDefined();
    expect(() => parseFlow(example!)).not.toThrow();
    // Every name the executor refuses has to be named here, or an author meets
    // it for the first time as a run-time refusal.
    for (const name of reservedScriptEnvNamesForMessage().split(", ")) {
      expect(section, name).toContain(name);
    }
    // And the precedence, which is what a reader comes to this section for.
    for (const layer of ["scripts.env.allow", "--env", "not a default"]) {
      expect(section).toContain(layer);
    }
  });

  it("keeps the two tool descriptions agreeing about where --env sits", () => {
    // The same discipline this file applies to the reference, applied to the
    // strings an agent reads BEFORE recording. `flow-add-script`'s description
    // and its `env` parameter said a real replay merges the run's own `--env`
    // values "under" this call's `env` over the flow file's own — which is
    // backwards: the run-time map is above the FILE's `env:` at every depth,
    // and `flow-execute`'s own parameter says so in the same commit. An agent
    // was told a recorded file-level value is what the replay takes, when
    // `argent flow run checkout --env BUILD=1421` replaces it.
    const runEnv = envParameterDescription(createRunFlowTool({} as unknown as Registry));
    expect(runEnv).toContain("OVERRIDE the flow file's own `env` defaults at every depth");
    expect(runEnv).toContain("a `script` step's own `env` still wins over them");
    // And it may not claim the secret sources are the ones `keyboard` reads.
    // They are not the same sources: this map is resolved against
    // `project_root`, and `keyboard`/`paste` carry no project, so they read the
    // two project files under the tool-server's own working directory — which
    // is whatever spawned it, and often `/` or a home directory.
    expect(runEnv).toContain("the same anchor the step resolves under");
    expect(runEnv).not.toMatch(/same sources `keyboard` uses/);

    const addEnv = envParameterDescription(flowAddScriptTool);
    for (const surface of [flowAddScriptTool.description, addEnv]) {
      // Whatever the wording, it may not put the run-time layer under the
      // file's own defaults.
      expect(surface).toMatch(/--env\/flow-execute values/);
      expect(surface).not.toMatch(/two (?:more|further) layers under those/);
    }
    expect(addEnv).toContain("BETWEEN the two layers here");
    expect(flowAddScriptTool.description).toContain("which sit BETWEEN those two");
  });

  it("names every flow-add-script wording that leaves nothing behind", () => {
    // The decision rule an agent applies to a failed call, and the reason it is
    // worth a test: a wording missing from the "nothing ran" list lands in the
    // "every other wording" bucket, and the agent goes looking for device or
    // database changes a call that never spawned a process cannot have made —
    // then retries a side-effecting script, which is what the rule exists to
    // stop. None of the three `env` refusals says the sentence the rule used to
    // promise for them; all three open with the parameter's own name.
    const liveAuthoring = readFileSync(LIVE_AUTHORING, "utf8");
    for (const wording of ["This call's", "was NOT run and nothing was recorded", "did not run"]) {
      expect(liveAuthoring, wording).toContain(wording);
    }
    // The marker is the two words in FRONT of the parameter, because the
    // output-reference refusal names `env.NAME` rather than `env`.
    // `flow-script-env.test.ts` drives the real tool for each of the four.
    expect(liveAuthoring).not.toContain("the refusal of the `env` argument");
  });

  it("keeps the run:-env remedy qualified wherever it is repeated", () => {
    // `execRunStep` layers a fragment's own `env:` OVER the flow that runs it,
    // so writing a dropped value into the RECORDING's top-level `env:` does
    // nothing for a name the fragment declares: the script still reads the
    // fragment's value, which is the outcome the warning exists to prevent.
    // `flow-add-step`'s warning carries that qualification and is pinned; the
    // two places that repeat the remedy dropped it.
    const qualified = /only for a name that (?:fragment|flow) does not itself declare/;
    expect(flowFinishRecordingTool.description).toMatch(qualified);
    expect(flowFinishRecordingTool.description).toMatch(/layers OVER the flow that runs it/);
    const liveAuthoring = readFileSync(LIVE_AUTHORING, "utf8");
    expect(liveAuthoring).toMatch(qualified);
    expect(liveAuthoring).toMatch(/layers OVER the flow that runs it/);
  });

  it("lists a script path among what a flow_path run re-anchors", () => {
    const schema = zodObjectToJsonSchema(
      createRunFlowTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, { description?: string }> };
    const projectRoot = schema.properties.project_root?.description;
    expect(projectRoot, "`project_root` no longer describes itself").toBeDefined();
    expect(projectRoot!).toMatch(/with flow_path[^.]*script:/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { zodObjectToJsonSchema, type Registry } from "@argent/registry";
import {
  IDLE_DEFAULT_STABLE_FOR_MS,
  IDLE_POLL_MS,
  IDLE_SETTLE_SPAN_MS,
  idleMinimumTimeoutMs,
  parseFlow,
} from "../../src/tools/flows/flow-utils";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

const FLOW_YAML = path.resolve(
  __dirname,
  "../../../skills/skills/argent-create-e2e/references/e2e-yaml.md"
);

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

describe("create-flow idle docs", () => {
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

/**
 * `project_root` is the only agent-facing statement of where a `script:` path
 * resolves from, so that claim is pinned here rather than left to prose review.
 */
describe("create-flow script docs", () => {
  it("lists a script path among what an e2e_test_path run re-anchors", () => {
    // `project_root` still names the script's working directory either way; it
    // is the RESOLUTION that moves to the YAML, and a `script:` path is the
    // third thing that moves with it.
    const schema = zodObjectToJsonSchema(
      createRunFlowTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, { description?: string }> };
    const projectRoot = schema.properties.project_root?.description;
    expect(projectRoot, "`project_root` no longer describes itself").toBeDefined();
    expect(projectRoot!).toMatch(/with e2e_test_path[^.]*script:/);
  });
});

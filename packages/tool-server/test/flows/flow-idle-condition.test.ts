import { describe, expect, it } from "vitest";
import { parseFlow, serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

// `idle` is the one condition that takes no selector. It shares the `await:`
// key with the selector conditions, so the parse/serialize round trip and the
// mutual exclusion between the two families are the load-bearing behaviors.

const flow = (steps: string): string => `executionPrerequisite: ""\nsteps:\n${steps}`;

function parseSteps(steps: string): FlowStep[] {
  return parseFlow(flow(steps)).steps;
}

/** A flow's steps survive serialize → parse unchanged (canonical spelling). */
function expectRoundTrip(steps: string): FlowStep[] {
  const parsed = parseSteps(steps);
  expect(parseFlow(serializeFlow({ executionPrerequisite: "", steps: parsed })).steps).toEqual(
    parsed
  );
  return parsed;
}

describe("await { idle }", () => {
  it("parses the readiness gate and round-trips its minimal spelling", () => {
    const steps = expectRoundTrip(`  - await: { idle: true }\n`);
    expect(steps).toEqual([{ kind: "idle" }]);
    // Minimal in, minimal out — no defaults materialize into the file.
    expect(serializeFlow({ executionPrerequisite: "", steps })).toContain(
      "await:\n      idle: true"
    );
  });

  it("carries the optional hold and timeout", () => {
    expect(expectRoundTrip(`  - await: { idle: true, minStableMs: 400, timeout: 9000 }\n`)).toEqual(
      [{ kind: "idle", minStableMs: 400, timeout: 9000 }]
    );
  });

  it("has no assert form — waiting is the whole point of the check", () => {
    expect(() => parseSteps(`  - assert: { idle: true }\n`)).toThrow(/idle has no assert form/);
  });

  it("takes only `true` — there is no useful 'prove the screen is moving'", () => {
    expect(() => parseSteps(`  - await: { idle: false }\n`)).toThrow(/idle takes only/);
  });

  it("bounds minStableMs", () => {
    expect(() => parseSteps(`  - await: { idle: true, minStableMs: -1 }\n`)).toThrow(
      /idle.minStableMs/
    );
    expect(() => parseSteps(`  - await: { idle: true, minStableMs: 1.5 }\n`)).toThrow(
      /idle.minStableMs/
    );
  });

  // A hold that cannot fit inside the wait is a gate that fails on every run —
  // and fails blaming the app, which is the one thing it is not evidence
  // about. Caught at parse, deviceless, rather than against a live screen.
  it("rejects a hold that could never fit inside the timeout", () => {
    expect(() =>
      parseSteps(`  - await: { idle: true, timeout: 500, minStableMs: 1000 }\n`)
    ).toThrow(
      /idle.minStableMs needs an integer between 0 and 499 .* fit inside the 500ms timeout/
    );
    // With no explicit timeout the default is what it has to fit inside, and
    // the message says which number it is measuring against.
    expect(() => parseSteps(`  - await: { idle: true, minStableMs: 9000 }\n`)).toThrow(
      /fit inside the default 7500ms timeout/
    );
    // The boundary itself is legal on both sides.
    expect(parseSteps(`  - await: { idle: true, timeout: 500, minStableMs: 499 }\n`)).toEqual([
      { kind: "idle", timeout: 500, minStableMs: 499 },
    ]);
    expect(() => parseSteps(`  - await: { idle: true, timeout: 500, minStableMs: 500 }\n`)).toThrow(
      /idle.minStableMs/
    );
  });

  it("rejects a non-positive timeout", () => {
    expect(() => parseSteps(`  - await: { idle: true, timeout: 0 }\n`)).toThrow(/await.timeout/);
    expect(() => parseSteps(`  - await: { idle: true, timeout: "soon" }\n`)).toThrow(
      /await.timeout/
    );
  });
});

describe("condition families are mutually exclusive", () => {
  it("rejects mixing a selector condition with the readiness one", () => {
    expect(() => parseSteps(`  - await: { idle: true, visible: { id: x } }\n`)).toThrow(
      /mixes `idle` with `visible`/
    );
  });

  it("rejects a stray key rather than ignoring it", () => {
    expect(() => parseSteps(`  - await: { idle: true, settleMs: 500 }\n`)).toThrow(/settleMs/);
  });

  // A typo next to an `idle:` gate used to be told that `idle` itself was not a
  // legal key — the parser lists what the AUTHOR may write, which is not the
  // same set as what its selector-condition branch parses.
  it("offers idle when an await names no legal condition", () => {
    expect(() => parseSteps(`  - await: { visble: { id: home } }\n`)).toThrow(
      /await needs exactly one condition key \(exists, visible, hidden, text, idle\)/
    );
    // Same list when the body isn't a condition map at all.
    expect(() => parseSteps(`  - await: visible\n`)).toThrow(
      /await needs a condition \(exists, visible, hidden, text, idle\)/
    );
  });

  it("does not offer it to assert or to a `when:` guard, which have no readiness form", () => {
    const assertMiss = (): FlowStep[] => parseSteps(`  - assert: { visble: { id: home } }\n`);
    expect(assertMiss).toThrow(
      /assert needs exactly one condition key \(exists, visible, hidden, text\)/
    );
    expect(assertMiss).not.toThrow(/idle/);

    const guard = (body: string) => (): FlowStep[] =>
      parseSteps(`  - when: ${body}\n    steps:\n      - echo: guarded\n`);

    // A stray key carrying neither substring, so the rejected entry echoed
    // back into the message cannot satisfy the negative assertion.
    const stray = guard("{ visble: { id: home } }");
    expect(stray).toThrow(
      /when needs exactly one condition key \(exists, visible, hidden, text, platform\)/
    );
    expect(stray).not.toThrow(/idle/);

    // And `idle` itself is not a guard.
    expect(guard("{ idle: true }")).toThrow(/when needs exactly one condition key/);
  });

  it("leaves the selector conditions untouched", () => {
    expect(parseSteps(`  - await: { visible: { id: home-screen } }\n`)).toEqual([
      { kind: "await", condition: "visible", selector: { identifier: "home-screen" } },
    ]);
  });
});

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
    expect(expectRoundTrip(`  - await: { idle: true, stableFor: 400, timeout: 9000 }\n`)).toEqual([
      { kind: "idle", stableFor: 400, timeout: 9000 },
    ]);
  });

  it("has no assert form — waiting is the whole point of the check", () => {
    expect(() => parseSteps(`  - assert: { idle: true }\n`)).toThrow(/idle has no assert form/);
  });

  it("takes only `true` — there is no useful 'prove the screen is moving'", () => {
    expect(() => parseSteps(`  - await: { idle: false }\n`)).toThrow(/idle takes only/);
  });

  it("bounds stableFor", () => {
    expect(() => parseSteps(`  - await: { idle: true, stableFor: -1 }\n`)).toThrow(
      /idle.stableFor/
    );
    expect(() => parseSteps(`  - await: { idle: true, stableFor: 1.5 }\n`)).toThrow(
      /idle.stableFor/
    );
    // And from above, so a hold written in the wrong unit (seconds, a pasted
    // timestamp) is rejected as a number rather than becoming a gate no run
    // can pass. The ceiling is ten minutes; a `timeout` wide enough to contain
    // it is what the case below checks separately.
    expect(() => parseSteps(`  - await: { idle: true, stableFor: 600001 }\n`)).toThrow(
      /between 0 and 600000/
    );
    expect(parseSteps(`  - await: { idle: true, stableFor: 600000, timeout: 600600 }\n`)).toEqual([
      { kind: "idle", stableFor: 600000, timeout: 600600 },
    ]);
  });

  // A wait that cannot contain the settle it asks for is a gate that fails on
  // every run — and fails blaming the app, which is the one thing it is not
  // evidence about. Caught at parse, deviceless, rather than against a live
  // screen.
  //
  // The settle spans 400ms — three reads over two 200ms polls — and the hold is
  // counted ACROSS those polls, not after them, so what the wait has to contain
  // is the longer of the two plus the budget the closing round has to start
  // with. Summing them instead rejected steps the runner satisfies: measured
  // through the runner, `stableFor: 800` settles in ~820ms and the default hold
  // in ~411ms, against a demand of 1400ms and 850ms.
  it("rejects a wait that could never contain the settle it asks for", () => {
    expect(() => parseSteps(`  - await: { idle: true, timeout: 500, stableFor: 1000 }\n`)).toThrow(
      /idle needs a timeout of at least 1200ms to hold still for 1000ms/
    );
    // With no explicit hold the DEFAULT is what has to fit — the spelling that
    // slipped through, since leaving `stableFor` out was the way past the
    // check that only looked at a written-out one.
    expect(() => parseSteps(`  - await: { idle: true, timeout: 100 }\n`)).toThrow(
      /idle needs a timeout of at least 600ms to hold still for the default 250ms/
    );
    // Which is the same step as writing the default out, so it is rejected the
    // same way.
    expect(() => parseSteps(`  - await: { idle: true, timeout: 100, stableFor: 250 }\n`)).toThrow(
      /idle needs a timeout of at least 600ms/
    );
    // With no explicit timeout the default is what the hold has to fit inside.
    expect(() => parseSteps(`  - await: { idle: true, stableFor: 9000 }\n`)).toThrow(
      /idle needs a timeout of at least 9200ms/
    );
    // Under the span, the span is the floor and the hold does not add to it —
    // both of these ask for the same 600ms.
    expect(() => parseSteps(`  - await: { idle: true, timeout: 599, stableFor: 0 }\n`)).toThrow(
      /idle needs a timeout of at least 600ms/
    );
    expect(() => parseSteps(`  - await: { idle: true, timeout: 599, stableFor: 400 }\n`)).toThrow(
      /idle needs a timeout of at least 600ms/
    );
    // The boundary itself is legal on both sides.
    expect(parseSteps(`  - await: { idle: true, timeout: 700, stableFor: 500 }\n`)).toEqual([
      { kind: "idle", timeout: 700, stableFor: 500 },
    ]);
    expect(() => parseSteps(`  - await: { idle: true, timeout: 699, stableFor: 500 }\n`)).toThrow(
      /idle needs a timeout of at least 700ms/
    );
  });

  // The floor is not merely smaller — it is the one the runner needs. A hold
  // the parser calls impossible must not be one a still screen serves, which is
  // what the additive sum produced: these are the two cases measured above.
  it("accepts the smallest wait the runner can actually settle in", () => {
    expect(parseSteps(`  - await: { idle: true, timeout: 1000, stableFor: 800 }\n`)).toEqual([
      { kind: "idle", timeout: 1000, stableFor: 800 },
    ]);
    expect(parseSteps(`  - await: { idle: true, timeout: 600 }\n`)).toEqual([
      { kind: "idle", timeout: 600 },
    ]);
  });

  // The one near-miss the docs actively produce: every other condition is
  // written with a selector beside it, so `await:` comes along for free, while
  // this one reads like a directive of its own.
  it("names the spelling when `idle` is written as a step of its own", () => {
    expect(() => parseSteps(`  - idle: true\n`)).toThrow(
      /idle is a condition, not a step kind — write it as `await: \{ idle: true \}`/
    );
  });

  // The hold is validated as an integer while the timeout is not, so a
  // fractional timeout used to be turned into a bound for the hold and asked
  // for "an integer between 0 and -0.5". Nothing is derived from it now: the
  // two are checked against each other as a sum, which has an answer whatever
  // the timeout is.
  it("rejects a timeout too small to settle in without inventing a range", () => {
    const parse = (): FlowStep[] =>
      parseSteps(`  - await: { idle: true, timeout: 0.5, stableFor: 0 }\n`);
    expect(parse).toThrow(/idle needs a timeout of at least 600ms/);
    expect(parse).not.toThrow(/between 0 and -/);
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

  // The same mix under `assert` used to cost two round trips: it reported the
  // mixing first, and the split the author was told to write —
  // `assert: { idle: true }` — is not valid either. One error has to end it.
  it("sends an assert body that mixes the two straight to the form it needs", () => {
    let message = "";
    try {
      parseSteps(`  - assert: { idle: true, visible: { id: x } }\n`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("idle has no assert form");
    expect(message).toContain("await: { idle: true }");
    expect(message).toContain("`visible`");
    // And what it tells the author to write must itself parse.
    expect(() =>
      parseSteps(`  - await: { idle: true }\n  - assert: { visible: { id: x } }\n`)
    ).not.toThrow();
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

    // And `idle` itself is not a guard — which is said outright, the way the
    // assert form is, rather than left to be inferred from a list it is
    // missing from.
    expect(guard("{ idle: true }")).toThrow(
      /when has no idle form .* Put `await: \{ idle: true \}` before the block/
    );
  });

  it("leaves the selector conditions untouched", () => {
    expect(parseSteps(`  - await: { visible: { id: home-screen } }\n`)).toEqual([
      { kind: "await", condition: "visible", selector: { identifier: "home-screen" } },
    ]);
  });
});

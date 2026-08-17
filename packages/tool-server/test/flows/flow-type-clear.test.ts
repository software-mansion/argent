import { describe, expect, it } from "vitest";
import { parseFlow, serializeFlow } from "../../src/tools/flows/flow-utils";

const wrap = (body: string) => `steps:\n  - type:\n${body}`;

function parseType(body: string) {
  const [step] = parseFlow(wrap(body)).steps;
  if (!step || step.kind !== "type") throw new Error(`expected a type step, got ${step?.kind}`);
  return step;
}

describe("flow `type` — clear parsing", () => {
  it("parses `clear: true` alongside text", () => {
    const step = parseType(
      `      into: { text: Email }\n      text: "new@example.com"\n      clear: true`
    );
    expect(step.clear).toBe(true);
    expect(step.text).toBe("new@example.com");
  });

  it("accepts a clear-only step with no text", () => {
    // Emptying a field is an end in itself — resetting a search filter, dropping a
    // restored draft, clearing a box a later step types into — so `clear` with no
    // text is a legitimate step. Before `clear`, a missing text was an
    // unconditional parse error.
    //
    // What follows it is NOT an assert on the empty state: `equals: ""` and
    // `contains: ""` are rejected at parse time, and `matches: '^$'` parses but
    // never fires, because absent or empty text is not a haystack. Such a step is
    // proved by the OLD value's absence, or by the consequence — tabulated in
    // `argent-create-flow/references/asserting-field-values.md`.
    const step = parseType(`      into: search\n      clear: true`);
    expect(step.clear).toBe(true);
    expect(step.text).toBeUndefined();
  });

  it("still rejects a step with neither text nor clear", () => {
    expect(() => parseType(`      into: search`)).toThrow(/non-empty text/);
  });

  it("rejects a bare-scalar `type`, naming BOTH shapes the body can take", () => {
    // Reached by extrapolating the scalar form `tap`, `long-press`, `scroll-to`
    // and `snapshot` accept. Nothing exercised it, so the message could name
    // either shape alone and stay green — and pointing an author at one of two
    // valid shapes is its own dead end.
    for (const body of [`steps:\n  - type: search\n`, `steps:\n  - type: 5\n`]) {
      expect(() => parseFlow(body), body).toThrow(/\{ into, text \} or \{ into, clear: true \}/);
      // …and the diagnostic locates the step, rather than rendering the body
      // it could not read.
      expect(() => parseFlow(body), body).toThrow(/\{"type":/);
    }
  });

  it("still rejects an empty text when clear is absent", () => {
    expect(() => parseType(`      into: search\n      text: ""`)).toThrow(/non-empty text/);
  });

  it("rejects an empty text even when clear is set", () => {
    // `text: ""` is a mistake either way — a clear-only step omits `text`.
    expect(() => parseType(`      into: search\n      clear: true\n      text: ""`)).toThrow(
      /non-empty string/
    );
  });

  it("rejects a misspelled `claer` instead of silently keeping the old value", () => {
    // The whole point of the allowlist: a dropped `clear` turns a replace into
    // a type into whatever is already there — which on Android and Chromium
    // splices the new text into the old value rather than appending it — and
    // that fails much later at an assert.
    expect(() => parseType(`      into: search\n      claer: true\n      text: "x"`)).toThrow(
      /claer/
    );
  });

  it("rejects a clear-only step with no `into`, as a validation failure", () => {
    // The diagnostic renders the offending entry, and `JSON.stringify` returns
    // undefined for undefined — so reading `.length` off it replaced the whole
    // message with "Cannot read properties of undefined" under a
    // REGISTRY_TOOL_EXECUTION_FAILED code. Through the real server that is what
    // `type: { clear: true }` returned, for a flow the parser can name exactly.
    //
    // And the entry it renders is the STEP, not the absent selector: handing
    // the missing `into` to `parseSelector` rendered the entry as the bare word
    // `undefined`, which in a multi-step flow says nothing about which step is
    // broken.
    expect(() => parseType(`      clear: true`)).toThrow(/needs an `into` selector/);
    expect(() => parseType(`      clear: true`)).toThrow(/\{"type":\{"clear":true\}\}/);
    expect(() => parseType(`      text: "x"`)).toThrow(/\{"type":\{"text":"x"\}\}/);
  });

  it("rejects a non-boolean clear", () => {
    expect(() => parseType(`      into: search\n      clear: "yes"\n      text: "x"`)).toThrow(
      /type.clear must be a boolean/
    );
  });
});

describe("flow `type` — submit defaults", () => {
  it("defaults submit to true when there is text", () => {
    const step = parseType(`      into: search\n      text: "x"`);
    // Stored only when it differs from the default, so an unset `submit` here
    // means "submit".
    expect(step.submit).toBeUndefined();
  });

  it("keeps an explicit submit: false alongside text", () => {
    const step = parseType(`      into: search\n      text: "x"\n      submit: false`);
    expect(step.submit).toBe(false);
  });

  it("does not store submit: false on a clear-only step (it is the default)", () => {
    const step = parseType(`      into: search\n      clear: true\n      submit: false`);
    expect(step.submit).toBeUndefined();
  });

  it("stores an explicit submit: true on a clear-only step (differs from default)", () => {
    const step = parseType(`      into: search\n      clear: true\n      submit: true`);
    expect(step.submit).toBe(true);
  });
});

describe("flow `type` — clear round-trips through serialize", () => {
  const roundTrip = (yaml: string) => parseFlow(serializeFlow(parseFlow(yaml)));

  it("preserves clear + text + submit:false", () => {
    const yaml = wrap(
      `      into: { text: Email }\n      text: "new@example.com"\n      clear: true\n      submit: false`
    );
    expect(roundTrip(yaml).steps).toEqual(parseFlow(yaml).steps);
    expect(serializeFlow(parseFlow(yaml))).toContain("clear: true");
  });

  it("preserves a clear-only step", () => {
    const yaml = wrap(`      into: search\n      clear: true`);
    const out = serializeFlow(parseFlow(yaml));
    expect(roundTrip(yaml).steps).toEqual(parseFlow(yaml).steps);
    expect(out).toContain("clear: true");
    // Nothing to type and nothing to submit — neither key should appear.
    expect(out).not.toContain("text:");
    expect(out).not.toContain("submit:");
  });

  it("preserves an explicit submit:true on a clear-only step", () => {
    const yaml = wrap(`      into: search\n      clear: true\n      submit: true`);
    const out = serializeFlow(parseFlow(yaml));
    expect(out).toContain("submit: true");
    expect(roundTrip(yaml).steps).toEqual(parseFlow(yaml).steps);
  });

  it("does not emit `clear` for a plain type step", () => {
    const yaml = wrap(`      into: search\n      text: "x"`);
    expect(serializeFlow(parseFlow(yaml))).not.toContain("clear:");
  });
});

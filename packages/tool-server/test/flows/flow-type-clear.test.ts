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
    // "empty the box, then assert the empty state" is a legitimate step. Before
    // `clear`, a missing text was an unconditional parse error.
    const step = parseType(`      into: search\n      clear: true`);
    expect(step.clear).toBe(true);
    expect(step.text).toBeUndefined();
  });

  it("still rejects a step with neither text nor clear", () => {
    expect(() => parseType(`      into: search`)).toThrow(/non-empty text/);
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

  it("rejects a misspelled `claer` instead of silently appending", () => {
    // The whole point of the allowlist: a dropped `clear` turns a replace into
    // an append, which fails much later at an assert.
    expect(() => parseType(`      into: search\n      claer: true\n      text: "x"`)).toThrow(
      /claer/
    );
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

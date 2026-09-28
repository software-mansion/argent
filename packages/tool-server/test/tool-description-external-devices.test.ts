import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

/**
 * Descriptions reach every agent on connect. Almost no machine has a provider,
 * so the catalog says nothing about them and the rules travel on paths that
 * exist only when a provider does: `list-devices`' `hint` and the runtime
 * denials.
 *
 * Swept catalog-wide, not per file. The prose crept in one sentence at a time.
 */
const PROVIDER_VOCABULARY = [
  /\bexternal device/i,
  /\bdevice provider/i,
  /\bexternal provider/i,
  /'external: true'/i,
  /\bext:/,
  /\bprovider\b/i,
];

/**
 * No allowlist. There was one, for `provider=<engine>` where screenshot-diff
 * names its OCR engine, but that spelling only ever appears in the tool's
 * result, never in a description, so the exemption matched nothing and stood
 * open; `provider=external` would have been erased before the sweep read the
 * line.
 *
 * Should the catalog ever gain a legitimate unrelated `provider`, exempt that
 * token alone rather than the line carrying it. Dropping the whole line would
 * excuse everything beside it and `provider=ocr; use the external provider`
 * would pass on the strength of its first half.
 */
function offendingLines(text: string): string[] {
  return text.split("\n").filter((line) => PROVIDER_VOCABULARY.some((p) => p.test(line)));
}

/** Every description a client receives, the tool's, plus each parameter's. */
function agentFacingText(def: ToolDefinition<any, any>): string[] {
  const texts: string[] = [];
  if (def.description) texts.push(def.description);

  const schema = advertisedSchema(def);
  const properties = (schema?.properties ?? {}) as Record<string, { description?: unknown }>;

  for (const [name, property] of Object.entries(properties)) {
    if (typeof property?.description === "string") texts.push(`${name}: ${property.description}`);
  }

  return texts;
}

/**
 * The sweep below asserts an absence, so it passes just as well when it has
 * stopped looking. These two hold the instrument itself to account: that the
 * vocabulary still fires and that there is text for it to fire on.
 */
describe("the sweep can still find what it looks for", () => {
  it.each([
    "Pick the external device the provider offers.",
    "Pass the ext: id from list-devices.",
    "Set 'external: true' to reach a device provider.",
    /** The line the removed `provider=<engine>` exemption would have erased. */
    "provider=external",
  ])("flags %j", (line) => {
    expect(offendingLines(line)).toEqual([line]);
  });

  it("reads a description and its parameters, so the catalog sweep has input", () => {
    const definitions = definitionsById(createRegistry());
    const texts = [...definitions.values()].flatMap(agentFacingText);

    expect(texts.length).toBeGreaterThan(definitions.size);
    expect(texts.every((text) => text.length > 0)).toBe(true);
  });
});

describe("device providers stay out of the always-shipped catalog", () => {
  const definitions = definitionsById(createRegistry());

  for (const [id, definition] of definitions) {
    it(`${id}: neither its description nor its parameters mention a device provider`, () => {
      const offending = agentFacingText(definition).flatMap(offendingLines);

      expect(
        offending,
        `${id} ships provider prose to every agent. Move it behind a runtime path that ` +
          `exists only when a provider does.`
      ).toEqual([]);
    });
  }
});
